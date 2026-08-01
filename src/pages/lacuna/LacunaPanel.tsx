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
        const div = composition.section?.[0]?.text?.div;
        if (!div) throw new Error('Composition section[0].text.div missing');
        const parsed = JSON.parse(extractJsonFromDiv(div)) as IntakeNote;
        if (cancelled) return;
        setNote(parsed);

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

  return (
    <div className="lacuna-root">
      <div className="lacuna-header">
        <div className="lacuna-brand">Lacuna intake review</div>
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
                reviews={[]}
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
                  reviews={[]}
                  onClick={goToTurn}
                  activeTurn={activeTurn}
                />
              ))}
            </p>
          ))}
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

// Suppress unused-warning for imported Finding type; useful if we later
// filter or map findings for reviewer overlays.
export type { Finding };
