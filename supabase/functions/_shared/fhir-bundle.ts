// Qlinic — ABDM OPConsultation FHIR R4 bundle builder.
//
// Why a pure function, isolated from any Edge Function's request
// handling: this is Milestone B of the ABDM/ABHA plan
// (plans/robust-questing-walrus.md) - fully testable offline, with
// hand-constructed sample rows, before any live sandbox credentials
// exist. It has zero network/DB dependency of its own; the caller
// (hip-health-info-request, a later milestone) is responsible for
// fetching these rows and doing anything with the result.
//
// Deliberately minimal-but-valid: Qlinic collects a patient's name,
// age, gender, and free-text reason, plus a doctor's name/specialty
// and the fee actually charged - it has no diagnosis codes, no
// structured chief-complaint coding, no vitals. Every section below
// either has a real coded value or falls back to a plain-text
// narrative div, per FHIR's own convention for "no coded data exists
// here" rather than inventing codes Qlinic never actually captured.
//
// Verify by diffing this output's shape (resourceType, Bundle.type,
// Composition.section structure) against NHA's own published
// OPConsultation examples - not a byte-for-byte match, but
// structurally conformant. See:
// https://github.com/Nirmitee-tech/abdm-fhir-bundle-examples

export interface CareContextInput {
  id: string;
  referenceNumber: string;
  display: string;
}

export interface InvoiceInput {
  id: string;
  invoiceDate: string; // 'YYYY-MM-DD'
  feeType: 'consultation' | 'emergency' | 'waived';
}

export interface PatientInput {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'other';
  age: number | null;
  reason: string;
  abhaAddress: string | null;
  abhaNumber: string | null;
}

export interface DoctorInput {
  id: string;
  name: string;
  specialty: string;
  hprId: string | null;
}

// deno-lint-ignore no-explicit-any
type FhirResource = Record<string, any>;

const NRCES_OP_CONSULT_PROFILE = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/OPConsultRecord';
const NRCES_DOCUMENT_BUNDLE_PROFILE = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/DocumentBundle';

function narrativeDiv(text: string): FhirResource {
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(text)}</div>`,
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// FEE_TYPE_LABELS mirrors billing-consultation.html's own FEE_TYPE_LABELS
// (consultation/emergency/waived) - kept as a plain narrative label here
// since ABDM's coded consultation-type value sets don't map cleanly onto
// "who paid what," which is a billing distinction, not a clinical one.
const FEE_TYPE_LABELS: Record<InvoiceInput['feeType'], string> = {
  consultation: 'Consultation',
  emergency: 'Emergency consultation',
  waived: 'Follow-up (no charge)',
};

/**
 * Builds a FHIR R4 Bundle (type: "document") for one OPConsultation
 * care context: Composition + Patient + Practitioner + Encounter.
 * Pure function - no I/O, no randomness beyond crypto.randomUUID()
 * (available globally in the Deno runtime, no import needed).
 */
export function buildOpConsultationBundle(
  careContext: CareContextInput,
  invoice: InvoiceInput,
  patient: PatientInput,
  doctor: DoctorInput,
): FhirResource {
  const bundleId = crypto.randomUUID();
  const compositionId = crypto.randomUUID();
  const patientId = crypto.randomUUID();
  const practitionerId = crypto.randomUUID();
  const encounterId = crypto.randomUUID();
  const now = new Date().toISOString();
  const encounterStart = `${invoice.invoiceDate}T00:00:00+05:30`;

  const patientResource: FhirResource = {
    resourceType: 'Patient',
    id: patientId,
    identifier: buildPatientIdentifiers(patient),
    name: [{ text: patient.name }],
    gender: patient.gender,
  };

  const practitionerResource: FhirResource = {
    resourceType: 'Practitioner',
    id: practitionerId,
    identifier: doctor.hprId
      ? [{ system: 'https://hpr.abdm.gov.in', value: doctor.hprId }]
      : undefined,
    name: [{ text: doctor.name }],
    qualification: doctor.specialty
      ? [{ code: { text: doctor.specialty } }]
      : undefined,
  };

  const encounterResource: FhirResource = {
    resourceType: 'Encounter',
    id: encounterId,
    status: 'finished',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'AMB',
      display: 'ambulatory',
    },
    type: [{ text: FEE_TYPE_LABELS[invoice.feeType] }],
    subject: { reference: `urn:uuid:${patientId}` },
    participant: [{ individual: { reference: `urn:uuid:${practitionerId}` } }],
    period: { start: encounterStart },
    reasonCode: patient.reason ? [{ text: patient.reason }] : undefined,
  };

  // Chief Complaint section: free-text narrative only - Qlinic never
  // collects a coded complaint/diagnosis, so a "generated" narrative
  // div is the honest representation, not an invented SNOMED code.
  const chiefComplaintSection: FhirResource = {
    title: 'Chief Complaint',
    code: {
      coding: [{
        system: 'http://snomed.info/sct',
        code: '422843007',
        display: 'Chief complaint section',
      }],
    },
    text: narrativeDiv(patient.reason || 'Not recorded.'),
  };

  const compositionResource: FhirResource = {
    resourceType: 'Composition',
    id: compositionId,
    meta: { profile: [NRCES_OP_CONSULT_PROFILE] },
    language: 'en-IN',
    status: 'final',
    type: {
      coding: [{
        system: 'http://snomed.info/sct',
        code: '371530004',
        display: 'Clinical consultation report',
      }],
    },
    subject: { reference: `urn:uuid:${patientId}` },
    encounter: { reference: `urn:uuid:${encounterId}` },
    date: now,
    author: [{ reference: `urn:uuid:${practitionerId}` }],
    title: 'Consultation Record',
    section: [chiefComplaintSection],
  };

  const bundle: FhirResource = {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      versionId: '1',
      lastUpdated: now,
      profile: [NRCES_DOCUMENT_BUNDLE_PROFILE],
    },
    identifier: { system: 'https://ndhm.in', value: careContext.referenceNumber },
    type: 'document',
    timestamp: now,
    entry: [
      { fullUrl: `urn:uuid:${compositionId}`, resource: compositionResource },
      { fullUrl: `urn:uuid:${patientId}`, resource: patientResource },
      { fullUrl: `urn:uuid:${practitionerId}`, resource: practitionerResource },
      { fullUrl: `urn:uuid:${encounterId}`, resource: encounterResource },
    ],
  };

  return pruneUndefined(bundle);
}

function buildPatientIdentifiers(patient: PatientInput): FhirResource[] | undefined {
  const identifiers: FhirResource[] = [];
  if (patient.abhaAddress) {
    identifiers.push({ system: 'https://healthid.ndhm.gov.in', value: patient.abhaAddress });
  }
  if (patient.abhaNumber) {
    identifiers.push({ system: 'https://abha.abdm.gov.in', value: patient.abhaNumber });
  }
  return identifiers.length > 0 ? identifiers : undefined;
}

// FHIR tooling generally tolerates absent optional fields better than
// explicit nulls/undefined keys sitting in the JSON - this keeps the
// output clean for diffing against reference examples rather than
// cluttered with "qualification: undefined" noise.
function pruneUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
