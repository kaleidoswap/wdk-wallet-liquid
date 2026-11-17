# Changelog

## Unreleased

### Fixed

- `LiquidAccount.fundLiquidPset` unblinds a confidential payout to an address this account owns, including a receive address that a freshly built wallet has not scanned. The returned `paymentOutputSecrets` are that output's asset id, value, and asset and value blinding factors. A confidential address this account cannot unblind still fails, and the error says the output was blinded to a key this wallet does not hold. Unconfidential payouts are unchanged, and a confidential payout is not rewritten as an explicit one.
