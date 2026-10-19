# Execution provenance: local review example

This is a synthetic service-request **status update**, prepared for Sanjay's review before any outreach to NIST/NCCoE. It is not an agency application, NIST submission, certification, or endorsement. It neither issues permits nor makes eligibility decisions.

The example exercises the published packages **FootPrint.js (`footprintjs`) 10.1.0** and **HCIFootprint (`hcifootprint`) 3.0.0**, with transitive **foottrace 1.5.0** locked in `package-lock.json`. The captured review run used Node **v24.19.0** on macOS arm64; it was also verified on Node v24.21.0. Both direct packages require Node 22 or newer. No model, LLM API key, agent, cloud account, external service, deployment, or real personal data is needed to run the example.

## Run

From this directory, with Node 22 or newer:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The first command downloads only the locked npm dependencies. The test itself operates locally and makes no network calls. The script exits nonzero when a required assertion fails. It regenerates `../evidence/report.json`, native records under `../evidence/native/`, and `../evidence/run-summary.txt`. Re-running changes native timestamps and run identifiers; the fixtures and expected outcomes are deterministic.

## What is implemented

A scripted caller requests that `DEMO-REQUEST-001` change from `open` to `closed`. HCIFootprint declares the action with `confirm: true`, `writes`, an application-owned `verify` predicate, and an enforcing session (`requireHumanApproval: true`). Its `confirmAsk`, `approveAsk`, and `fire` APIs implement the single-use approval check. The native served-action API is used for the caller's `confirm:true` test; no unsupported `confirm` option is added to `fire`.

The host's approval control is simulated with `approveAsk(..., { by: 'synthetic-reviewer' })`. This is a **scripted, host-attributed decision**, not a real human approval or authentication test. Host code controls the principal and must keep the approval API out of an untrusted caller's reach.

FootPrint runs a three-stage orchestration flow (`record-attempt`, `invoke-boundary`, `observe-local-state`). Each invoked application handler runs a separate three-stage FootPrint flow (`handler-enter`, `apply-local-change`, `handler-return`) that performs the real in-memory mutation and retains its input, before/after snapshots, and return value. Inline native scope recorder hooks retain reads, writes, commits, and stage events. Assertions check the expected commit stages, retained values, and absence of recorder errors. The demonstration has no deferred observer queue or configured sampling.

The adapter explicitly passes the HCIFootprint transition ID when reporting normal handler state changes. It never infers this association from timestamps. Cross-library correlation IDs, scenario labels, expected-state comparison, report schema, and file export are **example-owned adapter logic**, not a native combined feature of either library. The adapter copies tracked scope data to a plain JSON value before handing it to HCIFootprint's input-binding comparison.

## Targeted scenarios

| Scenario | Expected boundary and local result |
|---|---|
| `missing-approval` | `APPROVAL_REQUIRED`; handler never entered; state unchanged |
| `self-confirm` | Served caller's `confirm:true` is refused without a recorded decision |
| `changed-input` | `APPROVAL_MISMATCH`; approval was for a different request ID |
| `changed-action` | `APPROVAL_MISMATCH`; approval was for close, not archive |
| `approved-once` | Dispatch accepted; one handler execution; one local revision; expected state observed |
| `approval-reuse` | One successful setup invocation consumes the approval; measured replay is `APPROVAL_SPENT` and causes no further change |
| `returned-without-effect` | Dispatch accepted and handler returns, but injected no-op leaves state open; native `verifyHeld:false` and settlement `refused` |
| `failure-after-write` | Handler changes local state, then returns a failure object before publishing its state delta; settlement is `refused`, but local effects exist |
| `direct-handler-boundary` | A raw application handler is called outside the session; local state changes without a native fired transition or approval record |

In the no-op case, declared **write keys** were reported (`effectVerified:true` in the native transition), yet the application's condition did not hold (`verifyHeld:false`). Key presence, handler completion, and expected value are three distinct observations. In the failure-after-write fixture, HCIFootprint's session state projection is not updated on that failure path; the separate instrumented application observation sees the already-applied local change. A refused outcome is not a rollback guarantee.

## Evidence files and interpretation

`../evidence/report.json` is an adapter-owned summary with `schemaVersion`, dependency/runtime/source identity, capture settings, nine `scenarios`, and limitations. Each scenario contains `attempt`, `approval`, `dispatch`, `settlement`, `execution`, `observation`, `pass`, and relative `nativeArtifacts` paths.

Each scenario has three native-record exports:

- `native/<id>.hci.json`: results of native `confirms()`, `transitions()`, `commitLog()`, `gaps()`, and `state()` APIs. Wrapper descriptions and the replay setup field are export metadata.
- `native/<id>.footprint.json`: native outer-flow `RunResult` plus native recorder hook event payloads.
- `native/<id>.handler.json`: native handler-flow results and hook events. For a refused invocation the measured attempt has no handler run; replay includes its successful setup run, identified by `setupRunCount`.

`sourceIdentity` records SHA-256 hashes of `run.mjs` and the npm lockfile. Package versions, registry URLs and integrity values come from the lockfile. These hashes identify review artifacts; they are not signatures, execution attestations or evidence of a trusted acquisition channel.

## Trust boundary and limitations

- The caller is scripted. The tests do not evaluate a model's reasoning, prompt injection resistance, or model quality.
- Approval is consumed when invocation is accepted, before the deferred handler completes. `fire().ok` is dispatch acceptance; it does not mean the requested change occurred. The example awaits native `whenSettled` and reads actual local state separately.
- `source:'agent'` and the approval's `by` field are host-supplied labels. No identity provider, authentication, authorization service, or policy engine is added.
- The configured session policy covers high-effect agent calls through that session. Direct application calls, other host-designated principals, and unreported operations require host enforcement. The direct-call control demonstrates the limit explicitly.
- Observations and expected-value checks run in the same trusted process as the application. No independent sensor, database commit check, remote side-effect verification, or real-world outcome is established.
- Ordinary JSON records can be edited. No signing, tamper-evident log, remote attestation, cryptographic chain, formal proof, or completeness guarantee against a malicious host is supplied.
- Nine targeted assertions are useful regression evidence, not a comprehensive security evaluation or performance measurement. No NIST compliance, certification, endorsement, or production fitness is claimed.

All outreach and publication remain for Sanjay to review and authorize.
