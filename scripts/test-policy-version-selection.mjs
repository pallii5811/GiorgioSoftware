import {
  comparePolicyDocumentRecency,
  countPendingPotentiallyNewerPolicyDocuments,
  policyDocumentYear,
} from "../src/lib/sanita/policy-version-selection.ts";

let pass = 0;
let fail = 0;

function ok(condition, message) {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${message}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${message}`);
  }
}

const policy2023 = {
  canonicalUrl: "https://clinic.example/uploads/Polizza-RCT-RCO-2023.pdf",
  resourceType: "pdf",
  state: "COMPLETED",
};
const policy2024 = {
  canonicalUrl: "https://clinic.example/uploads/Polizza-RCT-RCO-2024.pdf",
  resourceType: "pdf",
  state: "QUEUED",
};
const policy2025 = {
  canonicalUrl: "https://clinic.example/uploads/Polizza-RCT-RCO-2025.pdf",
  resourceType: "pdf",
  state: "QUEUED",
};

ok(policyDocumentYear(policy2025.canonicalUrl) === 2025, "extracts version year from filename");
ok(comparePolicyDocumentRecency(policy2025, policy2023) < 0, "newest policy is scheduled first");
ok(
  countPendingPotentiallyNewerPolicyDocuments(
    [policy2023, policy2024, policy2025],
    policy2023.canonicalUrl
  ) === 2,
  "older selected policy is blocked while newer versions are unread"
);
ok(
  countPendingPotentiallyNewerPolicyDocuments(
    [policy2023, { ...policy2024, state: "COMPLETED" }, { ...policy2025, state: "COMPLETED" }],
    policy2025.canonicalUrl
  ) === 0,
  "newest completed policy is terminally eligible"
);
ok(
  countPendingPotentiallyNewerPolicyDocuments(
    [
      { ...policy2025, state: "COMPLETED" },
      {
        canonicalUrl: "https://clinic.example/uploads/polizza-rct-rco.pdf",
        resourceType: "pdf",
        state: "QUEUED",
      },
    ],
    policy2025.canonicalUrl
  ) === 1,
  "unversioned unread policy is conservatively treated as potentially newer"
);

console.log(`policy-version-selection: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
