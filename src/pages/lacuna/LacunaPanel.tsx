// SPDX-FileCopyrightText: Lacuna port
// SPDX-License-Identifier: Apache-2.0
//
// Additive Lacuna panel mounted inside the shell's EncounterChartPage as a
// child route: `/Patient/:patientId/Encounter/:encounterId/lacuna`.
//
// Does not touch EncounterChart.tsx, useEncounterChart.ts, or any other
// shell component. Reads the intake Composition that Lacuna wrote for
// this encounter, parses the embedded IntakeNote JSON, fetches the
// patient's chart resources live from Medplum, and renders the note as
// prose with click-to-transcript provenance.
import { useMedplum } from '@medplum/react';
import type {
  AllergyIntolerance,
  Composition,
  Condition,
  MedicationRequest,
  Patient,
} from '@medplum/fhirtypes';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useParams } from 'react-router';
import { clauseSeverity, renderHPI, type Clause } from './renderHPI';
import type { Finding, IntakeNote, ReviewFinding } from './types';
import './lacuna.css';

type Severity = 'blocking' | 'warning' | 'info';
type PlanApprovalStatus =
  | 'draft_agent_reviewed'
  | 'awaiting_physician'
  | 'physician_approved';

// Section[1] payload written by MedplumNoteStore.save when extras is passed.
// Optional throughout — a Composition predating the addendum has no section[1].
interface CompositionExtras {
  reviews?: {
    completeness?: ReviewFinding[];
    pharmacy?: ReviewFinding[];
    guidelines?: ReviewFinding[];
    history?: ReviewFinding[];
  } | null;
  conflicts?: Array<{ summary?: string; findings?: unknown[] }>;
  plan?: {
    status?: string;
    items?: Array<{
      id: string;
      action: string;
      category?: string;
      rationale?: string;
      drivenBy?: string[];
      confidence?: 'clear' | 'consider';
    }>;
    notAddressed?: string[];
  } | null;
  planContradictions?: Array<{ planItemId: string }>;
  research?: {
    sources?: Array<{ title: string; url: string; takeaway: string }>;
    error?: string | null;
  } | null;
  planApprovalStatus?: PlanApprovalStatus;
}

interface ChartLite {
  medications: Array<{
    id: string;
    name: string;
    dose?: string;
    frequency?: string;
    indication?: string;
    anticoagulant?: boolean;
    class?: string;
  }>;
  allergies: Array<{ id: string; substance: string; reaction: string; severity?: string }>;
  conditions: Array<{ id: string; name: string; note?: string; status?: string }>;
  demographics?: { age?: number; sex?: string };
}

function extractJsonFromDiv(div: string): string {
  const match = div.match(/<pre>([\s\S]*)<\/pre>/);
  if (!match) throw new Error('Composition section has no <pre> block');
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Well-known section titles the writer uses. Title-based lookup because
// A5 added FHIR-native sections (chief complaint, HPI, meds, allergies,
// plan) with LOINC codes — those live alongside the JSON payloads and
// can appear at any index.
const SECTION_TITLE_NOTE = 'IntakeNote (application/json)';
const SECTION_TITLE_EXTRAS = 'Reviewer output (application/json)';

function findSectionDivByTitle(composition: Composition, title: string): string | undefined {
  return composition.section?.find((s) => s.title === title)?.text?.div;
}

const ANTICOAG_RE =
  /anticoag|xa inhibitor|factor xa|doac|warfarin|coumadin|apixaban|eliquis|rivaroxaban|xarelto|dabigatran|pradaxa|edoxaban|savaysa|heparin|enoxaparin|lovenox/i;

function calcAge(birthDate?: string): number | undefined {
  if (!birthDate) return undefined;
  const bd = new Date(birthDate);
  if (Number.isNaN(bd.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - bd.getFullYear();
  const m = now.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) age--;
  return age;
}

function readMedicationDose(mr: MedicationRequest): { dose?: string; frequency?: string } {
  // Prefer dosageInstruction[0].doseAndRate + timing text; fall back to the
  // free-text notes we ourselves wrote.
  const d0 = mr.dosageInstruction?.[0];
  const doseFromRate = d0?.doseAndRate?.[0]?.doseQuantity;
  const dose = doseFromRate
    ? `${doseFromRate.value} ${doseFromRate.unit ?? doseFromRate.code ?? ''}`.trim()
    : undefined;
  const timing = d0?.timing?.code?.text ?? d0?.text;
  // Also try the medicationCodeableConcept.text which Lacuna's seed writes
  // as "apixaban 5 mg BID" — grab dose from that if nothing else.
  const cc = mr.medicationCodeableConcept?.text ?? '';
  const doseMatch = /(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml))/i.exec(cc);
  const fallbackDose = doseMatch ? doseMatch[1] : undefined;
  const freqMatch = /(BID|TID|QID|QHS|daily|nightly|twice daily)/i.exec(cc);
  const fallbackFreq = freqMatch ? freqMatch[1] : undefined;
  return { dose: dose ?? fallbackDose, frequency: timing ?? fallbackFreq };
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function LacunaPanel(): JSX.Element {
  const { encounterId } = useParams();
  const medplum = useMedplum();
  const [note, setNote] = useState<IntakeNote | null>(null);
  const [chart, setChart] = useState<ChartLite | null>(null);
  const [compositionId, setCompositionId] = useState<string | null>(null);
  const [extras, setExtras] = useState<CompositionExtras | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const [activeSeverity, setActiveSeverity] = useState<Severity | null>(null);
  const turnRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (!encounterId) {
      setError('No encounter id in route');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // 1. Composition for this encounter (Lacuna wrote exactly one).
        const composition = (await medplum.searchOne(
          'Composition',
          `encounter=Encounter/${encounterId}`,
        )) as Composition | undefined;
        if (!composition) throw new Error(`No Composition for Encounter/${encounterId}`);
        setCompositionId(composition.id ?? null);
        // Title-based lookup — A5 added FHIR-native sections in front, so
        // index [0] is no longer the JSON note.
        const noteDiv = findSectionDivByTitle(composition, SECTION_TITLE_NOTE);
        if (!noteDiv) {
          throw new Error(`Composition has no "${SECTION_TITLE_NOTE}" section`);
        }
        const parsed = JSON.parse(extractJsonFromDiv(noteDiv)) as IntakeNote;
        if (cancelled) return;
        setNote(parsed);

        // Reviewer output section. Optional — a Composition written before
        // A2 landed has no such section; render note-and-transcript only.
        const extrasDiv = findSectionDivByTitle(composition, SECTION_TITLE_EXTRAS);
        if (extrasDiv) {
          try {
            const parsedExtras = JSON.parse(extractJsonFromDiv(extrasDiv)) as CompositionExtras;
            if (!cancelled) setExtras(parsedExtras);
          } catch {
            if (!cancelled) setExtras(null);
          }
        }

        // 2. Patient (for demographics). The write path stores subject
        // either as `Patient?identifier=...` (conditional reference) or
        // `Patient/uuid` (direct reference) depending on the code path.
        const patientRef = composition.subject?.reference;
        if (!patientRef) throw new Error('Composition has no subject');
        let patient: Patient | undefined;
        if (patientRef.startsWith('Patient?')) {
          const q = patientRef.slice('Patient?'.length);
          const identifier = new URLSearchParams(q).get('identifier');
          if (identifier) {
            patient = (await medplum.searchOne('Patient', `identifier=${identifier}`)) as Patient | undefined;
          }
        } else if (patientRef.startsWith('Patient/')) {
          patient = (await medplum.readReference({ reference: patientRef })) as Patient;
        }

        // 3. Chart resources scoped to this patient.
        const patientId = patient?.id;
        const [meds, allergies, conditions] = patientId
          ? await Promise.all([
              medplum.searchResources('MedicationRequest', `patient=Patient/${patientId}&_count=50`) as Promise<MedicationRequest[]>,
              medplum.searchResources('AllergyIntolerance', `patient=Patient/${patientId}&_count=50`) as Promise<AllergyIntolerance[]>,
              medplum.searchResources('Condition', `patient=Patient/${patientId}&_count=50`) as Promise<Condition[]>,
            ])
          : ([[], [], []] as [MedicationRequest[], AllergyIntolerance[], Condition[]]);

        const chartLite: ChartLite = {
          demographics: patient
            ? { age: calcAge(patient.birthDate), sex: patient.gender }
            : undefined,
          medications: meds.map((mr) => {
            const name = mr.medicationCodeableConcept?.coding?.[0]?.display
              ?? mr.medicationCodeableConcept?.text
              ?? mr.medicationReference?.display
              ?? 'medication';
            const cc = mr.medicationCodeableConcept?.text ?? '';
            const anticoagulant = ANTICOAG_RE.test(`${name} ${cc}`);
            const noteTxt = mr.note?.[0]?.text ?? '';
            const indicationMatch = /Indication:\s*(.+)$/i.exec(noteTxt);
            const { dose, frequency } = readMedicationDose(mr);
            return {
              id: mr.id ?? '',
              name: /(\w+)/.exec(name)?.[1] ?? name,
              dose,
              frequency,
              indication: indicationMatch ? indicationMatch[1] : undefined,
              anticoagulant,
              class: cc,
            };
          }),
          allergies: allergies.map((ai) => ({
            id: ai.id ?? '',
            substance: ai.code?.text
              ?? ai.code?.coding?.[0]?.display
              ?? 'allergen',
            reaction: ai.reaction?.[0]?.manifestation?.[0]?.text ?? 'reaction unspecified',
            severity: ai.reaction?.[0]?.severity,
          })),
          conditions: conditions.map((c) => ({
            id: c.id ?? '',
            name: c.code?.text ?? c.code?.coding?.[0]?.display ?? 'condition',
            note: c.note?.[0]?.text,
            status: c.clinicalStatus?.coding?.[0]?.code,
          })),
        };
        if (cancelled) return;
        setChart(chartLite);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [encounterId, medplum]);

  const hpi = useMemo(() => {
    if (!note || !chart) return null;
    return renderHPI(note, chart);
  }, [note, chart]);

  if (error) {
    return (
      <div className="lacuna-root lacuna-error">
        <strong>Lacuna panel:</strong> {error}
      </div>
    );
  }
  if (!note || !chart || !hpi) {
    return <div className="lacuna-root lacuna-loading">Loading Lacuna intake…</div>;
  }

  const goToTurn = (turn: number | null, severity: Severity | null): void => {
    if (turn === null) return;
    setActiveTurn(turn);
    setActiveSeverity(severity);
    turnRefs.current[turn]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const allReviews: ReviewFinding[] = extras?.reviews
    ? [
        ...(extras.reviews.completeness ?? []),
        ...(extras.reviews.pharmacy ?? []),
        ...(extras.reviews.guidelines ?? []),
        ...(extras.reviews.history ?? []),
      ]
    : [];
  const defects = allReviews.filter((r) => r.kind === 'defect');
  const context = allReviews.filter((r) => r.kind === 'context');
  const approval: PlanApprovalStatus = extras?.planApprovalStatus ?? 'draft_agent_reviewed';
  const conflicts = extras?.conflicts ?? [];
  const planItems = extras?.plan?.items ?? [];
  const contradictionIds = new Set(
    (extras?.planContradictions ?? []).map((c) => c.planItemId),
  );
  const severityRank: Record<Severity, number> = { blocking: 0, warning: 1, info: 2 };
  const sortedDefects = [...defects].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  );

  return (
    <div className="lacuna-root">
      <div className="lacuna-header">
        <div className="lacuna-brand">
          Lacuna intake review
          <span className={`lacuna-approval lacuna-approval-${approval}`}>
            {approval === 'physician_approved'
              ? 'approved for patient'
              : approval === 'awaiting_physician'
                ? 'awaiting physician'
                : 'draft, agent-reviewed'}
          </span>
        </div>
        {compositionId && (
          <a
            className="lacuna-medplum-link"
            href={`https://app.medplum.com/Composition/${compositionId}`}
            target="_blank"
            rel="noreferrer"
            title="Open source Composition in Medplum"
          >
            Composition/{compositionId.slice(0, 8)}…
          </a>
        )}
      </div>

      <div className="lacuna-cols">
        <div className="lacuna-main">
          <div className="lacuna-cap">History of present illness</div>
          <p className="lacuna-hpi">
            {hpi.paragraphs[0]?.clauses.map((clause, j) => (
              <ClauseSpan
                key={j}
                clause={clause}
                reviews={allReviews}
                onClick={goToTurn}
                activeTurn={activeTurn}
              />
            ))}
          </p>
          {hpi.paragraphs.slice(1).map((para, i) => (
            <p className="lacuna-para-secondary" key={i}>
              <span className="lacuna-para-caption">{para.caption}</span>
              {para.clauses.map((clause, j) => (
                <ClauseSpan
                  key={j}
                  clause={clause}
                  reviews={allReviews}
                  onClick={goToTurn}
                  activeTurn={activeTurn}
                />
              ))}
            </p>
          ))}

          {extras && (
            <>
              {(conflicts.length > 0 || defects.length > 0 || context.length > 0) && (
                <div className="lacuna-band">
                  <div className="lacuna-cap">Annotations</div>
                  {conflicts[0] && (
                    <div className="lacuna-ann d lead">
                      <h4>Contradiction — unresolved</h4>
                      <p>{conflicts[0].summary ?? 'Contradiction detected.'}</p>
                    </div>
                  )}
                  {sortedDefects.map((r, i) => (
                    <Annotation key={`d${i}`} review={r} />
                  ))}
                  {context.length > 0 && (
                    <div className="lacuna-cap lacuna-cap-inline">Context</div>
                  )}
                  {context.map((r, i) => (
                    <Annotation key={`c${i}`} review={r} />
                  ))}
                </div>
              )}

              {planItems.length > 0 && (
                <div className="lacuna-band">
                  <div className="lacuna-cap">Proposed — not ordered</div>
                  {planItems.map((item) => (
                    <div key={item.id} className="lacuna-prop">
                      <div className="lacuna-prop-head">
                        <strong>{item.action}</strong>
                        {item.confidence && (
                          <span className={`lacuna-chip lacuna-chip-${item.confidence}`}>
                            {item.confidence === 'clear' ? 'covered' : 'consider'}
                          </span>
                        )}
                        {item.category && (
                          <span className="lacuna-chip lacuna-chip-cat">{item.category}</span>
                        )}
                        {contradictionIds.has(item.id) && (
                          <span className="lacuna-chip lacuna-chip-conflict">contradiction</span>
                        )}
                      </div>
                      {item.rationale && (
                        <div className="lacuna-prop-why">{item.rationale}</div>
                      )}
                      {item.drivenBy && item.drivenBy.length > 0 && (
                        <div className="lacuna-prop-driven">
                          drivenBy: {item.drivenBy.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {extras.research && extras.research.sources && extras.research.sources.length > 0 && (
                <div className="lacuna-band">
                  <div className="lacuna-cap">
                    Research · {extras.research.sources.length} sources
                  </div>
                  <details className="lacuna-research">
                    <summary>Show sources</summary>
                    {extras.research.sources.map((s, i) => (
                      <div key={i} className="lacuna-research-item">
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                        <div className="lacuna-research-take">{s.takeaway}</div>
                      </div>
                    ))}
                  </details>
                </div>
              )}
            </>
          )}
          {!extras && (
            <div className="lacuna-band lacuna-note-hint">
              <div className="lacuna-cap">Annotations</div>
              <div>
                This Composition predates the reviewer-output addendum
                (Composition section[1]). Annotations, plan items, and
                approval state will appear here after the next
                extract run.
              </div>
            </div>
          )}
        </div>

        <div className="lacuna-side">
          <div className="lacuna-cap">Transcript</div>
          {note.transcript.map((t, i) => {
            const isPatientHl = activeTurn === i;
            const isAgentQuestion =
              activeTurn !== null &&
              i === activeTurn - 1 &&
              note.transcript[activeTurn - 1]?.speaker === 'agent';
            const isHl = isPatientHl || isAgentQuestion;
            const sevClass = activeSeverity ?? 'info';
            return (
              <div
                key={i}
                ref={(el) => {
                  turnRefs.current[i] = el;
                }}
                className={`lacuna-turn ${t.speaker === 'patient' ? 'pt' : 'ag'} ${
                  isHl ? `hot ${sevClass}` : ''
                }`}
              >
                <span className="lacuna-turn-n">{i}</span>
                <span className="lacuna-turn-sp">{t.speaker}</span>
                <div className="lacuna-turn-txt">{t.text}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clause span — three visual signals from the original:
//   dotted underline  = traceable (has finding, click to scroll transcript)
//   solid + doc icon  = chart-sourced
//   coloured bg       = defect at blocking severity
// The `reviews` array is currently empty because reviewer output isn't
// embedded in the Composition. When the ClinicalImpression addendum lands
// (Batch 2 / Path D), we can also embed reviews alongside the note.
// ---------------------------------------------------------------------------

function ClauseSpan(props: {
  clause: Clause;
  reviews: ReviewFinding[];
  onClick: (turn: number | null, severity: Severity | null) => void;
  activeTurn: number | null;
}): JSX.Element {
  const { clause, reviews, onClick, activeTurn } = props;
  const traceable = clause.findingIds.length > 0 || clause.evidenceTurn !== null;
  const severity = clauseSeverity(clause, reviews);
  const classes: string[] = ['lacuna-tr'];
  if (clause.isChart) classes.push('chart');
  if (severity === 'blocking') classes.push('block');
  if (clause.evidenceTurn !== null && activeTurn === clause.evidenceTurn) classes.push('sel');
  if (!traceable && !clause.isChart) {
    return <>{clause.text}</>;
  }
  const handleClick = (): void => {
    if (clause.evidenceTurn !== null) onClick(clause.evidenceTurn, severity);
  };
  return (
    <span
      className={classes.join(' ')}
      onClick={clause.evidenceTurn !== null ? handleClick : undefined}
      title={
        clause.isChart
          ? clause.chartRef ?? undefined
          : traceable
            ? 'click to scroll transcript'
            : undefined
      }
    >
      {clause.text.trimEnd()}
      {clause.isChart && <sup>◆</sup>}
      {clause.text.endsWith(' ') && ' '}
    </span>
  );
}

// Annotation card. Defects render with severity colour; context findings
// render with a neutral border and a small "context" tag. Both surface as
// annotations. Context findings are permanently-true clinical guardrails
// (G1, dual-antithrombotic, chart-resolve provenance, plan-risk context)
// — never counted as noise; the fork panel labels them so the physician
// can tell one from the other at a glance.
function Annotation(props: { review: ReviewFinding }): JSX.Element {
  const { review } = props;
  const cls =
    review.kind === 'context'
      ? 'ctx'
      : review.severity === 'blocking'
        ? 'd'
        : review.severity === 'warning'
          ? 'w'
          : 'a';
  return (
    <div className={`lacuna-ann ${cls}`}>
      <h4>
        {review.reviewer}
        {review.kind === 'context' && <span className="lacuna-kind-tag">context</span>}
      </h4>
      <p>{review.claim}</p>
      <div className="lacuna-ann-src">↳ {review.referent.source}</div>
    </div>
  );
}

// Suppress unused-warning for imported Finding type; useful if we later
// filter or map findings for reviewer overlays.
export type { Finding };
