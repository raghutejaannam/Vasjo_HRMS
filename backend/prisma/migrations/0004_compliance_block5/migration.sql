-- 0004_compliance_block5
--
-- Additive migration only. Block 5 (Tax & Compliance) turned out to need
-- almost no new schema — tax_declarations, tax_declaration_entries (with
-- proof upload + verify/reject), previous_employer_income, tax_regimes,
-- tax_slabs, tax_rules and deduction_limits already existed and already
-- covered the declaration/proof/verification workflow and the old-vs-new
-- regime comparison. This migration only adds the one column genuinely
-- missing: an ESI number on the employee record, needed for the new ESI
-- compliance report (src/compliance.js).

ALTER TABLE users ADD COLUMN esi_number TEXT;
