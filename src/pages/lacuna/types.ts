// Duplicated shapes from src/types/*. UI is a separate build; kept in sync
// manually. Small enough for a hackathon prep, not for production.

export type FindingStatus = 'stated' | 'denied' | 'unobtainable' | 'not_asked';

export interface Evidence {
  kind: 'utterance' | 'chart';
  // utterance fields:
  utterance?: string;
  language?: string;
  translation?: string | null;
  speaker?: 'patient' | 'agent';
  turnIndex?: number;
  // chart fields:
  resourceRef?: string;
  summary?: string;
  asOf?: string;
}

export interface Finding {
  id: string;
  field: string;
  phenomenon: string;
  label: string;
  category: string;
  value: string | null;
  status: FindingStatus;
  evidence: Evidence | null;
  gapReason: string | null;
  indicated: boolean;
  priority: 'critical' | 'important' | 'routine';
}

export interface IntakeNote {
  encounterId: string;
  patientId: string;
  chiefComplaint: string;
  findings: Finding[];
  transcript: { speaker: 'patient' | 'agent'; text: string }[];
}

export interface ReviewFinding {
  reviewer: 'pharmacy' | 'guidelines' | 'history' | 'completeness';
  kind: 'defect' | 'context';
  severity: 'blocking' | 'warning' | 'info';
  claim: string;
  referent: { source: string; detail: string };
  findingId: string | null;
}

export interface PlanItem {
  id: string;
  action: string;
  category: string;
  rationale: string;
  drivenBy: string[];
  confidence: 'clear' | 'consider';
}

export interface DraftPlan {
  status: string;
  items: PlanItem[];
  notAddressed: string[];
}

export interface ResearchSource {
  title: string;
  url: string;
  takeaway: string;
}

export interface UiChart {
  id: string;
  patientRef: string;
  demographics?: { age?: number; sex?: string };
  medications: Array<{
    id: string;
    name: string;
    dose?: string;
    frequency?: string;
    indication?: string;
    class?: string;
    anticoagulant?: boolean;
  }>;
  allergies: Array<{ id: string; substance: string; reaction: string; severity?: string }>;
  conditions: Array<{ id: string; name: string; note?: string; status?: string }>;
}

export interface UiData {
  note: IntakeNote;
  plan: DraftPlan;
  reviews: {
    completeness: ReviewFinding[];
    pharmacy: ReviewFinding[];
    guidelines: ReviewFinding[];
    history: ReviewFinding[];
  };
  conflicts: Array<{ findings: Finding[]; summary: string }>;
  planContradictions: Array<{ planItemId: string; findings: ReviewFinding[] }>;
  openItems: Finding[];
  research?: { sources: ResearchSource[]; error: string | null };
  chart: UiChart;
  presentationLabel?: string;
  medplumResource?: { reference: string; url: string };
}
