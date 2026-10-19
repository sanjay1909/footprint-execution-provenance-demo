import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildNavigationGraph, serveToAgent } from 'hcifootprint';
import { flowChart } from 'footprintjs';

// Synthetic application-owned adapter. These identifiers join the two libraries;
// they are not native cross-library causal proofs or authentication credentials.
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../evidence');
const CLOSE = 'desk.close-request';
const ARCHIVE = 'desk.archive-request';
const INPUT = Object.freeze({ requestId: 'DEMO-REQUEST-001' });
const HUMAN_FIXTURE = 'synthetic-reviewer';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const copy = (v) => JSON.parse(JSON.stringify(v, (_k, x) => x instanceof Error ? { name: x.name, message: x.message, ...x } : x));
const save = async (relative, data) => {
  const target = path.join(out, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(data, null, 2) + '\n');
};

function nativeRecorder() {
  const events = [];
  const recorder = { id: 'synthetic-provenance-capture' };
  for (const hook of ['onRead', 'onWrite', 'onCommit', 'onStageStart', 'onStageEnd', 'onEmit', 'onError']) {
    recorder[hook] = (event) => events.push({ hook, event: copy(event) });
  }
  return { recorder, events };
}

function fixture({ fault = false, failAfterWrite = false } = {}) {
  const app = { requestId: INPUT.requestId, status: 'open', revision: 0 };
  const stats = { entered: 0, returned: 0 };
  const handlerRuns = [];
  let transitionId;
  const session = buildNavigationGraph('service-desk', {
    does: 'Synthetic service-request status demonstration; no real public service.',
    pages: { desk: { actions: {
      'close-request': {
        does: 'Close the synthetic service request', confirm: true,
        input: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
        writes: ['requestStatus', 'requestRevision'],
        verify: () => app.status === 'closed',
      },
      'archive-request': {
        does: 'Archive the synthetic service request', confirm: true,
        input: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false },
        writes: ['requestStatus', 'requestRevision'],
        verify: () => app.status === 'archived',
      },
    } } },
  }).createSession({
    node: 'desk', state: { requestStatus: app.status, requestRevision: app.revision },
    requireHumanApproval: true, onWarn: () => {},
  });
  const handler = async (input, desiredStatus, reportToSession = true) => {
    const capture = nativeRecorder();
    const chart = flowChart('Handler entered', (s) => {
      stats.entered++;
      s.handlerEntered = true;
      s.receivedInput = copy(input);
      s.before = copy(app);
    }, 'handler-enter')
      .addFunction('Apply local status change', (s) => {
        const received = s.receivedInput;
        assert.equal(received.requestId, app.requestId, 'Only the synthetic fixture request may be mutated');
        if (!fault) { app.status = desiredStatus; app.revision++; }
        s.after = copy(app);
        s.faultInjected = fault;
      }, 'apply-local-change')
      .addFunction('Handler returns', (s) => {
        s.handlerReturned = true;
        s.returnValue = failAfterWrite
          ? { ok: false, error: 'Synthetic failure reported after the local change', requestId: s.receivedInput.requestId }
          : { handler: 'returned', requestId: s.receivedInput.requestId };
        stats.returned++;
      }, 'handler-return')
      .build();
    const run = await chart.recorder(capture.recorder).run();
    handlerRuns.push({ run, events: capture.events });
    if (reportToSession && !failAfterWrite) {
      // The explicit transition id travels along this one invocation path. No
      // timestamp matching or FIFO inference is used by this adapter.
      session.updateState({ requestStatus: app.status, requestRevision: app.revision }, { transitionId });
    }
    // Fault fixture: a failure path returns before publishing a session delta.
    // The adapter's separate local observation still sees the earlier mutation.
    return copy(run.state.returnValue);
  };
  session.registerActions('desk', { handlers: {
    'close-request': (input) => handler(input, 'closed'),
    'archive-request': (input) => handler(input, 'archived'),
  } });
  return {
    app, stats, session, handlerRuns,
    port: serveToAgent(session),
    async direct(input) { return handler(input, 'closed', false); },
    setTransition(id) { transitionId = id; },
  };
}

function approve(f, action = CLOSE, input = INPUT) {
  const ask = f.session.confirmAsk(action, { source: 'agent', input });
  const decision = f.session.approveAsk(ask.askId, {
    by: HUMAN_FIXTURE, note: 'Scripted fixture decision; not a person authenticating.',
  });
  assert.equal(decision.ok, true);
  return { askId: ask.askId, actionId: action, input: copy(input), by: HUMAN_FIXTURE, kind: 'scripted-host-decision' };
}

async function invoke(f, action, input, askId) {
  const fired = f.session.fire(action, { source: 'agent', payload: input, ...(askId ? { askId } : {}) });
  if (!fired.ok) return { dispatch: copy(fired), settlement: null };
  // fire() accepts/dispatches synchronously, before its deferred handler starts.
  const dispatch = { ok: true, transitionId: fired.transition.id, effectStatusAtReturn: fired.effectStatus };
  f.setTransition(fired.transition.id);
  const settlement = await fired.whenSettled;
  return { dispatch, settlement: copy(settlement) };
}

const specifications = [
  { id: 'missing-approval', title: 'No recorded approval', reason: 'APPROVAL_REQUIRED' },
  { id: 'self-confirm', title: 'Caller supplies confirm:true', reason: 'APPROVAL_REQUIRED', selfConfirm: true },
  { id: 'changed-input', title: 'Approval presented for different input', reason: 'APPROVAL_MISMATCH', approved: true, input: { requestId: 'DEMO-REQUEST-002' } },
  { id: 'changed-action', title: 'Approval presented for a different action', reason: 'APPROVAL_MISMATCH', approved: true, action: ARCHIVE },
  { id: 'approved-once', title: 'Recorded approval permits one local change', approved: true, allowed: true },
  { id: 'approval-reuse', title: 'Reusing a consumed approval', approved: true, replay: true, reason: 'APPROVAL_SPENT' },
  { id: 'returned-without-effect', title: 'Handler returns, expected state is absent', approved: true, allowed: true, fault: true },
  { id: 'failure-after-write', title: 'Handler reports failure after a local state change', approved: true, allowed: true, failAfterWrite: true },
  { id: 'direct-handler-boundary', title: 'Raw application method bypasses the session gate', direct: true, allowed: true },
];

async function scenario(spec) {
  const f = fixture({ fault: spec.fault, failAfterWrite: spec.failAfterWrite });
  let approval = null;
  if (spec.approved) approval = approve(f);
  let setup = null;
  if (spec.replay) {
    setup = await invoke(f, CLOSE, INPUT, approval.askId);
    assert.equal(setup.dispatch.ok, true);
    assert.equal(setup.settlement.effectStatus, 'performed');
  }
  const before = copy(f.app);
  const start = { ...f.stats };
  const handlerRunsBefore = f.handlerRuns.length;
  const actionId = spec.action ?? CLOSE;
  const input = spec.input ?? INPUT;
  const attempt = {
    correlationId: spec.id,
    actionId, input: copy(input), source: spec.direct ? 'direct-application-call' : 'agent',
    ...(approval ? { askId: approval.askId } : {}),
    ...(spec.selfConfirm ? { callerConfirmation: true } : {}),
  };
  const capture = nativeRecorder();
  let result;
  const orchestrator = flowChart('Record synthetic request', (s) => {
    s.attempt = attempt;
    s.before = before;
    s.approval = approval;
  }, 'record-attempt')
    .addFunction('Invoke application boundary', async (s) => {
      // The scope read is retained by FootPrint; the actual gate is HCIFootprint.
      // A detached plain-data boundary avoids handing FootPrint's tracked scope
      // proxy to a second library's input-binding comparison.
      const request = copy(s.attempt);
      if (spec.direct) {
        await f.direct(request.input);
        result = { dispatch: { ok: null, route: 'direct-application-call', reason: 'SESSION_GATE_NOT_CROSSED' }, settlement: null };
      } else if (spec.selfConfirm) {
        // confirm:true is exercised on the native served-action API, where it
        // belongs. It is not invented as an unsupported fire() parameter.
        const served = await f.port.call('service-desk.do_action', {
          action: 'close-request', input: request.input, confirm: true,
        });
        result = { dispatch: copy(served), settlement: null };
      } else result = await invoke(f, request.actionId, request.input, request.askId);
      s.dispatch = result.dispatch;
      s.settlement = result.settlement;
    }, 'invoke-boundary')
    .addFunction('Observe local application state', (s) => {
      s.after = copy(f.app);
      s.execution = {
        handlerEntered: f.stats.entered - start.entered,
        handlerReturned: f.stats.returned - start.returned,
      };
      s.observation = {
        before: s.before, after: s.after, expectedStatus: 'closed',
        statusMatches: s.after.status === 'closed',
        revisionDelta: s.after.revision - s.before.revision,
        effectMatches: s.after.status === 'closed' && s.after.revision === s.before.revision + 1,
      };
    }, 'observe-local-state')
    .build();
  const run = await orchestrator.recorder(capture.recorder).run();
  const { dispatch, settlement, execution, observation } = run.state;
  assert.equal(capture.events.filter(event => event.hook === 'onError').length, 0, 'Inline recorder must not fail');
  assert.deepEqual(run.commitLog.map(bundle => bundle.stageId), ['record-attempt', 'invoke-boundary', 'observe-local-state']);
  for (const nativeHandler of f.handlerRuns.slice(handlerRunsBefore)) {
    assert.equal(nativeHandler.events.filter(event => event.hook === 'onError').length, 0);
    assert.deepEqual(nativeHandler.run.commitLog.map(bundle => bundle.stageId), ['handler-enter', 'apply-local-change', 'handler-return']);
    assert.equal(nativeHandler.run.commitLog[0].overwrite.handlerEntered, true);
    assert.equal(nativeHandler.run.commitLog[2].overwrite.handlerReturned, true);
    assert.deepEqual(nativeHandler.run.commitLog[1].overwrite.after, observation.after);
  }
  if (spec.reason) {
    assert.equal(dispatch.ok, false, spec.id);
    assert.equal(dispatch.reason, spec.reason, spec.id);
    assert.equal(execution.handlerEntered, 0, spec.id);
    assert.equal(execution.handlerReturned, 0, spec.id);
    assert.deepEqual(observation.after, observation.before, spec.id);
  } else {
    if (!spec.direct) {
      assert.equal(dispatch.ok, true, spec.id);
      assert.equal(dispatch.effectStatusAtReturn, 'pending', spec.id);
    }
    assert.equal(execution.handlerEntered, 1, spec.id);
    assert.equal(execution.handlerReturned, 1, spec.id);
    assert.equal(observation.effectMatches, !spec.fault, spec.id);
    if (spec.fault) {
      assert.equal(settlement.effectStatus, 'refused');
      assert.equal(settlement.verifyHeld, false);
      assert.equal(settlement.transition.effectVerified, true, 'Observed keys alone do not prove the requested value');
    } else if (spec.failAfterWrite) {
      assert.equal(settlement.effectStatus, 'refused');
      assert.equal(settlement.error, 'Synthetic failure reported after the local change');
      assert.equal(observation.revisionDelta, 1, 'A refused handler outcome does not roll back effects');
      assert.equal(f.session.confirms().filter(row => row.kind === 'used').length, 1, 'Approval was already consumed');
    } else if (!spec.direct) {
      assert.equal(settlement.effectStatus, 'performed');
      assert.equal(settlement.verifyHeld, true);
    }
  }
  if (spec.direct) {
    assert.equal(f.session.confirms().length, 0);
    assert.equal(f.session.transitions().filter(t => t.cause.kind === 'fired').length, 0, 'No native action invocation is recorded for a direct application call');
  }
  const prefix = `native/${spec.id}`;
  const nativeArtifacts = {
    hci: `${prefix}.hci.json`,
    footprint: `${prefix}.footprint.json`,
    handler: `${prefix}.handler.json`,
  };
  await save(nativeArtifacts.hci, {
    origin: 'Native HCIFootprint session API snapshots; wrapper labels are demonstration metadata.',
    confirms: f.session.confirms(), transitions: f.session.transitions(), commitLog: f.session.commitLog(),
    gaps: f.session.gaps(), state: f.session.state(), ...(setup ? { setup } : {}),
  });
  await save(nativeArtifacts.footprint, { origin: 'Native FootPrint.js RunResult and recorder hook events.', run, events: capture.events });
  await save(nativeArtifacts.handler, {
    origin: 'Native FootPrint.js handler RunResults and recorder hook events. These are instrumented handler observations, not independent external verification.',
    setupRunCount: handlerRunsBefore, runs: f.handlerRuns,
  });
  return {
    id: spec.id, title: spec.title,
    expected: spec.reason ?? (spec.fault ? 'DISPATCHED_BUT_EXPECTED_STATE_ABSENT' : spec.failAfterWrite ? 'FAILURE_WITH_LOCAL_EFFECT' : spec.direct ? 'OUTSIDE_SESSION_BOUNDARY' : 'ONE_APPROVED_CHANGE'),
    attempt, approval, dispatch, settlement, execution, observation, pass: true,
    nativeArtifacts,
    footprintStageIds: ['record-attempt', 'invoke-boundary', 'observe-local-state'],
  };
}

await mkdir(out, { recursive: true });
const scenarios = [];
for (const spec of specifications) scenarios.push(await scenario(spec));
const lockBytes = await readFile(path.join(here, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key.startsWith('node_modules/')).map(([key, p]) => [key.slice(13), {
  version: p.version, resolved: p.resolved, integrity: p.integrity,
}]));
const report = {
  schemaVersion: '1.0.0', generatedAt: new Date().toISOString(),
  title: 'Execution provenance for a synthetic, human-approved service-request update',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  capture: { delivery: 'inline', recorderErrors: 0, configuredSampling: false, deferredQueue: false },
  dependencies,
  sourceIdentity: {
    'run.mjs': { sha256: sha256(await readFile(fileURLToPath(import.meta.url))) },
    'package-lock.json': { sha256: sha256(lockBytes) },
  },
  summary: { total: scenarios.length, passed: scenarios.length, failed: 0 },
  scenarios,
  limitations: [
    'All actors, requests and host-attributed approval decisions are synthetic fixtures. No agency, person, identity provider or production data is used.',
    'source: agent and by: synthetic-reviewer are supplied by the host. HCIFootprint does not authenticate a human or create an authorization service.',
    'The session policy gates configured high-effect agent invocation paths. Direct application calls and differently trusted principal paths remain host responsibilities.',
    'Cross-library correlation, scenario labels and expected-state comparisons are demonstration-owned adapter logic, not a new native FootPrint or HCIFootprint feature.',
    'Records are ordinary local JSON. There is no signature, tamper-evident chain, independent witness, formal proof or external-transaction verification.',
    'The effect check reads only in-memory application state in the same trusted process; it does not prove a database commit, remote service result or real-world outcome.',
    'Deterministic scripted calls exercise the application boundary; no model, model-quality claim, agent or model API is involved.',
    'Nine targeted scenarios are not a comprehensive security evaluation, performance study, NIST certification or evidence of NIST endorsement.',
  ],
};
await save('report.json', report);
await writeFile(path.join(out, 'run-summary.txt'), [
  `FootPrint.js ${dependencies.footprintjs.version}; HCIFootprint ${dependencies.hcifootprint.version}; Node ${process.version}`,
  ...scenarios.map((s) => `PASS ${s.id}: dispatch=${String(s.dispatch.ok)}; reason=${s.dispatch.reason ?? '-'}; handler=${s.execution.handlerEntered}/${s.execution.handlerReturned}; effect=${s.observation.effectMatches}; settlement=${s.settlement?.effectStatus ?? '-'}`),
  `${scenarios.length}/${scenarios.length} scenarios passed`,
].join('\n') + '\n');
console.log(await readFile(path.join(out, 'run-summary.txt'), 'utf8'));
