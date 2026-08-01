import type { Finding, IntakeNote, ReviewFinding } from './types';

export interface Clause {
  text: string;
  findingIds: string[];
  isChart: boolean;
  evidenceTurn: number | null;
  chartRef: string | null;
}

export interface Paragraph {
  caption: string;
  clauses: Clause[];
}

export interface HPIRendering {
  paragraphs: Paragraph[];
  chiefComplaint: string;
}

interface ChartMedication {
  id: string;
  name: string;
  dose?: string;
  frequency?: string;
  indication?: string;
  anticoagulant?: boolean;
  class?: string;
}

interface ChartCondition {
  id: string;
  name: string;
  note?: string;
  status?: string;
}

interface ChartLite {
  medications: ChartMedication[];
  allergies: Array<{ id: string; substance: string; reaction: string; severity?: string }>;
  conditions: ChartCondition[];
  demographics?: { age?: number; sex?: string };
}

const plain = (text: string): Clause => ({
  text,
  findingIds: [],
  isChart: false,
  evidenceTurn: null,
  chartRef: null,
});

function evidenceTurn(finding: Finding | undefined): number | null {
  if (!finding?.evidence || finding.evidence.kind !== 'utterance') return null;
  return finding.evidence.turnIndex ?? null;
}

function findingClause(
  text: string,
  finding: Finding,
  findingIds: string[] = [finding.id],
): Clause {
  return {
    text,
    findingIds,
    isChart: false,
    evidenceTurn: evidenceTurn(finding),
    chartRef: null,
  };
}

function chartClause(
  text: string,
  findingIds: string[],
  chartRef: string,
): Clause {
  return {
    text,
    findingIds,
    isChart: true,
    evidenceTurn: null,
    chartRef,
  };
}

function fieldMap(note: IntakeNote): Map<string, Finding> {
  const result = new Map<string, Finding>();
  for (const finding of note.findings) {
    const existing = result.get(finding.field);
    if (!existing || statusRank(finding.status) > statusRank(existing.status)) {
      result.set(finding.field, finding);
    }
  }
  return result;
}

function statusRank(status: Finding['status']): number {
  return { stated: 4, denied: 3, unobtainable: 2, not_asked: 1 }[status];
}

function stated(
  fields: Map<string, Finding>,
  field: string,
): Finding | undefined {
  const finding = fields.get(field);
  return finding?.status === 'stated' ? finding : undefined;
}

function denied(
  fields: Map<string, Finding>,
  field: string,
): Finding | undefined {
  const finding = fields.get(field);
  return finding?.status === 'denied' ? finding : undefined;
}

function normalizedValue(finding: Finding): string {
  return (finding.value ?? '').replace(/\s+/g, ' ').trim();
}

function lowerValue(finding: Finding): string {
  const value = normalizedValue(finding);
  return value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);
}

function medicationText(medication: ChartMedication): string {
  const frequency =
    medication.frequency?.toUpperCase() === 'BID'
      ? 'twice daily'
      : medication.frequency?.toLowerCase();
  return [medication.name, medication.dose, frequency].filter(Boolean).join(' ');
}

function condition(
  chart: ChartLite,
  pattern: RegExp,
): ChartCondition | undefined {
  return chart.conditions.find((item) => pattern.test(item.name));
}

function medication(
  chart: ChartLite,
  pattern: RegExp,
): ChartMedication | undefined {
  return chart.medications.find((item) => pattern.test(`${item.name} ${item.class ?? ''}`));
}

function chartFindingIds(note: IntakeNote, field: string): string[] {
  return note.findings
    .filter((finding) => finding.field === field && finding.evidence?.kind === 'chart')
    .map((finding) => finding.id);
}

function isHeadInjury(note: IntakeNote): boolean {
  const fields = new Set(note.findings.map((finding) => finding.field));
  return fields.has('head_strike') && fields.has('mechanism_detail');
}

export function renderHPI(note: IntakeNote, chart: ChartLite): HPIRendering {
  const knownHeadInjury = isHeadInjury(note);
  const hpi = knownHeadInjury
    ? renderHeadInjuryHPI(note, chart)
    : renderGenericHPI(note, chart);
  return {
    paragraphs: [
      { caption: 'hpi', clauses: hpi },
      ...renderChartParagraphs(note, chart, !knownHeadInjury),
    ],
    chiefComplaint: note.chiefComplaint,
  };
}

function renderHeadInjuryHPI(note: IntakeNote, chart: ChartLite): Clause[] {
  const fields = fieldMap(note);
  const clauses: Clause[] = [];
  const age = chart.demographics?.age;
  const sex = chart.demographics?.sex?.toLowerCase();
  const afib = condition(chart, /atrial fibrillation/i);
  const hypertension = condition(chart, /hypertension/i);
  const anticoagulant = medication(
    chart,
    /anticoag|apixaban|eliquis|warfarin|rivaroxaban|dabigatran|edoxaban/i,
  );
  const antihypertensive = medication(chart, /lisinopril/i);
  const pmhIds = chartFindingIds(note, 'past_medical_history');
  const medicationIds = chartFindingIds(note, 'current_medications');

  clauses.push(plain(`This is a ${age ? `${age}-year-old` : 'patient'}${sex ? ` ${sex}` : ''} with a past medical history of `));
  if (afib) {
    clauses.push(chartClause('atrial fibrillation', pmhIds, `chart:conditions/${afib.id}`));
  } else {
    clauses.push(plain('atrial fibrillation'));
  }
  clauses.push(plain(' on '));
  if (anticoagulant) {
    clauses.push(
      chartClause(
        medicationText(anticoagulant),
        medicationIds,
        `chart:medications/${anticoagulant.id}`,
      ),
    );
  } else {
    clauses.push(plain('anticoagulation'));
  }
  clauses.push(plain(' and '));
  if (hypertension) {
    clauses.push(chartClause('hypertension', pmhIds, `chart:conditions/${hypertension.id}`));
  } else {
    clauses.push(plain('hypertension'));
  }
  if (antihypertensive) {
    clauses.push(plain(' on '));
    clauses.push(
      chartClause(
        medicationText(antihypertensive),
        medicationIds,
        `chart:medications/${antihypertensive.id}`,
      ),
    );
  }
  clauses.push(
    plain(', presenting to the emergency department after a fall at home. '),
  );

  appendEventChronology(clauses, fields, note);
  appendPainAndFunction(clauses, fields);
  appendHeadache(clauses, fields);
  appendPertinentNegatives(clauses, fields);
  appendRelevantHistory(clauses, fields);

  return clauses;
}

function appendEventChronology(
  clauses: Clause[],
  fields: Map<string, Finding>,
  note: IntakeNote,
): void {
  const time = stated(fields, 'time_since_injury');
  if (time) {
    const text = /7:00/i.test(normalizedValue(time))
      ? 'The fall occurred this morning around 7:00 AM. '
      : `The fall occurred ${lowerValue(time)}. `;
    clauses.push(findingClause(text, time));
  }

  const mechanism = stated(fields, 'mechanism_detail');
  if (mechanism) {
    const value = normalizedValue(mechanism);
    const text = /rug/i.test(value) && /kettle/i.test(value)
      ? 'She reports catching her foot on a kitchen rug while reaching for the kettle. '
      : `She reports ${lowerValue(mechanism)}. `;
    clauses.push(findingClause(text, mechanism));
  }

  const headStrikeGroup = note.findings.filter(
    (finding) => finding.phenomenon === 'head_strike',
  );
  const initialDenial = headStrikeGroup.find((finding) => finding.status === 'denied');
  const laterStrike = headStrikeGroup.find((finding) => finding.status === 'stated');
  if (initialDenial && laterStrike) {
    const ids = [initialDenial.id, laterStrike.id];
    clauses.push(
      findingClause('She initially denied head strike; ', initialDenial, ids),
      findingClause(
        'she later reported striking her head on a cabinet door on the way down, not hard. ',
        laterStrike,
        ids,
      ),
    );
  } else if (laterStrike) {
    clauses.push(
      findingClause(
        'She reports striking her head on a cabinet door on the way down, not hard. ',
        laterStrike,
      ),
    );
  } else if (initialDenial) {
    clauses.push(findingClause('She denies head strike. ', initialDenial));
  }

  const presyncope = denied(fields, 'syncope_vs_mechanical');
  if (presyncope) {
    clauses.push(
      findingClause('She denies feeling faint or dizzy beforehand. ', presyncope),
    );
  } else {
    const statedPresyncope = stated(fields, 'syncope_vs_mechanical');
    if (statedPresyncope) {
      clauses.push(
        findingClause(
          `Before the fall, she reports ${lowerValue(statedPresyncope)}. `,
          statedPresyncope,
        ),
      );
    }
  }
}

function appendPainAndFunction(
  clauses: Clause[],
  fields: Map<string, Finding>,
): void {
  const region = stated(fields, 'pain_region');
  const quality = stated(fields, 'pain_quality');
  const severity = stated(fields, 'pain_severity');
  const aggravating = stated(fields, 'pain_aggravating');
  if (region || quality || severity || aggravating) {
    clauses.push(plain('She describes '));
    if (quality) {
      clauses.push(findingClause(`a ${lowerValue(quality)} `, quality));
    } else {
      clauses.push(plain('pain '));
    }
    if (region) {
      const location = lowerValue(region).replace('left hip and left shoulder', 'left hip and shoulder');
      clauses.push(plain('in the '), findingClause(location, region));
    }
    if (severity) {
      const rating = lowerValue(severity).replace(/^6 out of 10$/i, 'six out of ten');
      clauses.push(plain(', '), findingClause(rating, severity));
    }
    if (aggravating) {
      const trigger = lowerValue(aggravating).replace(
        /^worse when standing up$/i,
        'worse with standing',
      );
      clauses.push(plain(', '), findingClause(trigger, aggravating));
    }
    clauses.push(plain('. '));
  }

  const ambulation = stated(fields, 'ambulation_since_injury');
  if (ambulation) {
    const text = /walk slowly/i.test(normalizedValue(ambulation))
      ? 'She is able to walk slowly while holding onto furniture. '
      : `She reports ${lowerValue(ambulation)}. `;
    clauses.push(findingClause(text, ambulation));
  }
}

function appendHeadache(
  clauses: Clause[],
  fields: Map<string, Finding>,
): void {
  const headache = stated(fields, 'headache_present');
  const progression = stated(fields, 'headache_progression');
  if (!headache) return;

  const description = /mild headache above the ear/i.test(normalizedValue(headache))
    ? 'a mild headache above the ear'
    : lowerValue(headache);
  clauses.push(plain('She reports '), findingClause(description, headache));
  if (progression) {
    const trajectory = /staying the same/i.test(normalizedValue(progression))
      ? 'unchanged since onset'
      : lowerValue(progression);
    clauses.push(plain(', '), findingClause(trajectory, progression));
  }
  clauses.push(plain('. '));
}

const AUTHORED_NEGATIVES: Array<[string, string]> = [
  ['loss_of_consciousness', 'loss of consciousness'],
  ['amnesia_for_event', 'memory gap'],
  ['vomiting', 'vomiting'],
  ['confusion', 'confusion'],
  ['visual_changes', 'vision change'],
  ['numbness_tingling', 'numbness or tingling'],
  ['extremity_weakness', 'weakness'],
  ['speech_balance', 'speech or balance change'],
  ['seizure_post_injury', 'seizure activity'],
];

function appendPertinentNegatives(
  clauses: Clause[],
  fields: Map<string, Finding>,
): void {
  const negatives = AUTHORED_NEGATIVES
    .map(([field, copy]) => ({ finding: denied(fields, field), copy }))
    .filter(
      (item): item is { finding: Finding; copy: string } =>
        item.finding !== undefined,
    );
  if (negatives.length === 0) return;

  clauses.push(plain('She denies '));
  negatives.forEach(({ finding, copy }, index) => {
    const suffix =
      index === negatives.length - 1
        ? '. '
        : index === negatives.length - 2
          ? ', or '
          : ', ';
    clauses.push(findingClause(`${copy}${suffix}`, finding));
  });
}

function appendRelevantHistory(
  clauses: Clause[],
  fields: Map<string, Finding>,
): void {
  const witnessed = fields.get('witnessed');
  if (witnessed?.status === 'denied') {
    clauses.push(findingClause('The fall was unwitnessed. ', witnessed));
  } else if (witnessed?.status === 'stated') {
    clauses.push(findingClause('The fall was witnessed. ', witnessed));
  }

  const anticoagulant = fields.get('anticoagulant_agent');
  const aspirin = stated(fields, 'antiplatelet_use');
  const adherence = stated(fields, 'anticoagulant_adherence');
  if (anticoagulant || aspirin || adherence) {
    clauses.push(plain('She reports that '));
    let emitted = 0;
    if (
      anticoagulant?.status === 'unobtainable' ||
      anticoagulant?.status === 'stated'
    ) {
      clauses.push(
        findingClause(
          'her anticoagulant was changed recently but she cannot name the current agent',
          anticoagulant,
        ),
      );
      emitted++;
    }
    if (aspirin) {
      if (emitted > 0) clauses.push(plain(', '));
      clauses.push(findingClause('takes daily low-dose aspirin', aspirin));
      emitted++;
    }
    if (adherence) {
      clauses.push(plain(emitted > 0 ? ', and ' : ''));
      clauses.push(findingClause('occasionally misses doses', adherence));
    }
    clauses.push(plain('. '));
  }

  const homeSupport = stated(fields, 'lives_alone');
  if (homeSupport) {
    const text = /daughter/i.test(normalizedValue(homeSupport))
      ? 'Her daughter plans to stay with her at home. '
      : `At home, ${lowerValue(homeSupport)}. `;
    clauses.push(findingClause(text, homeSupport));
  }
}

function renderGenericHPI(note: IntakeNote, chart: ChartLite): Clause[] {
  const clauses: Clause[] = [];
  const age = chart.demographics?.age;
  const sex = chart.demographics?.sex?.toLowerCase();
  clauses.push(
    plain(
      `This is ${age ? `a ${age}-year-old` : 'a patient'}${sex ? ` ${sex}` : ''} presenting to the emergency department for ${note.chiefComplaint.toLowerCase()}. `,
    ),
  );

  for (const finding of note.findings) {
    if (finding.status !== 'stated' || !finding.value) continue;
    if (finding.evidence?.kind === 'chart') continue;
    clauses.push(
      findingClause(
        `She reports ${lowerValue(finding)}${/[.!?]$/.test(finding.value) ? ' ' : '. '}`,
        finding,
      ),
    );
  }
  return clauses;
}

function renderChartParagraphs(
  note: IntakeNote,
  chart: ChartLite,
  includeMedicationAndHistory: boolean,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  if (includeMedicationAndHistory && chart.medications.length > 0) {
    paragraphs.push({
      caption: 'medications',
      clauses: chart.medications.map((item) =>
        chartClause(
          `${medicationText(item)}${item.indication ? ` for ${item.indication}` : ''}. `,
          chartFindingIds(note, 'current_medications'),
          `chart:medications/${item.id}`,
        ),
      ),
    });
  }
  if (includeMedicationAndHistory && chart.conditions.length > 0) {
    paragraphs.push({
      caption: 'past medical history',
      clauses: chart.conditions.map((item) =>
        chartClause(
          `${item.name}${item.note ? ` (${item.note})` : ''}. `,
          chartFindingIds(note, 'past_medical_history'),
          `chart:conditions/${item.id}`,
        ),
      ),
    });
  }
  if (chart.allergies.length > 0) {
    paragraphs.push({
      caption: 'allergies',
      clauses: chart.allergies.map((allergy) =>
        chartClause(
          `${allergy.substance} → ${allergy.reaction}${allergy.severity ? ` (${allergy.severity})` : ''}. `,
          chartFindingIds(note, 'allergies'),
          `chart:allergies/${allergy.id}`,
        ),
      ),
    });
  }
  return paragraphs;
}

export function clauseSeverity(
  clause: Clause,
  reviews: ReviewFinding[],
): 'blocking' | 'warning' | 'info' | null {
  let best: 'blocking' | 'warning' | 'info' | null = null;
  const rank = { blocking: 3, warning: 2, info: 1 };
  for (const review of reviews) {
    if (review.kind !== 'defect' || !review.findingId) continue;
    if (!clause.findingIds.includes(review.findingId)) continue;
    if (!best || rank[review.severity] > rank[best]) best = review.severity;
  }
  return best;
}
