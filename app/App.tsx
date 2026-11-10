import { useEffect, useMemo, useRef, useState } from 'react';
import type { HybridResult, TestedPlan } from '../src/agent/hybrid';
import type { ResultSummary } from '../src/agent/evaluate';
import type { WhatIfResult } from '../src/agent/whatIf';
import type { BuiltModel } from '../src/agent/modelBuilder';
import { DEFAULT_COSTS, DEFAULT_COSTS_PROVENANCE, type Constraints, type CostTable } from '../src/agent/plan';
import { windowMinutes } from '../src/sim/arrivals';
import { lognormal } from '../src/sim/distributions';
import { toWindows, type CafeSpec } from '../src/sim/cafe';
import { ORDER_TYPE_LABEL, type OrderType } from '../src/sim/types';
import type { Interval } from '../src/sim/stats';
import { PRESETS } from '../src/presets';
import type { WorkerRequest, WorkerResponse } from './worker';
import { CaseStudy } from './CaseStudy';

// ---------------------------------------------------------------- worker plumbing
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
type NewRequest = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;
function call<T extends WorkerResponse['type']>(
  req: NewRequest,
  onProgress?: (p: { phase: string; done: number; total: number }) => void,
): Promise<Extract<WorkerResponse, { type: T }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') return onProgress?.(m);
      worker.removeEventListener('message', handler);
      if (m.type === 'error') reject(new Error(m.message));
      else resolve(m as Extract<WorkerResponse, { type: T }>);
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...req, id });
  });
}
const newAnalysisId = () => Math.random().toString(36).slice(2, 12);

// ---------------------------------------------------------------- small pieces
type Prov = 'OBSERVED' | 'SIMULATED' | 'ASSUMPTION' | 'PUBLISHED BENCHMARK' | 'PUBLIC DATA';
const Badge = ({ kind, children }: { kind: Prov | 'method' | 'ok' | 'no'; children?: React.ReactNode }) => (
  <span className={`badge badge-${kind.replace(/ /g, '-').toLowerCase()}`}>{children ?? kind}</span>
);
const min = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x.toFixed(1)} min`);
const ci = (i: Interval | undefined) => (i && Number.isFinite(i.low) ? `${i.low.toFixed(1)}–${i.high.toFixed(1)}` : '');
const pct = (x: number) => `${Math.abs(x * 100).toFixed(0)}%`;
const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
/** A plan in plain English: "Add 1 kitchen staff for the whole rush, and add 1 barista ...". */
const planText = (p: TestedPlan) => p.record.descriptions.map((d, i) => (i === 0 ? d : d[0].toLowerCase() + d.slice(1))).join(', and ');

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setHash(location.hash || '#/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return [hash, (h) => (location.hash = h)];
}

// ---------------------------------------------------------------- app
interface Setup {
  spec: CafeSpec;
  source: string;
  labels: string[];
  assumptions: string[];
}

export function App() {
  const [hash, go] = useHash();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [run, setRun] = useState<{ constraints: Constraints; costs: CostTable; useLlm: boolean; analysisId: string } | null>(null);

  const page = hash.startsWith('#/case-study') ? 'case' : hash.startsWith('#/setup') && setup ? 'setup' : hash.startsWith('#/results') && setup && run ? 'results' : 'home';
  return (
    <div className="shell">
      <header className="top">
        <a href="#/" className="brand">Rush Hour Lab</a>
        <nav>
          <a href="#/">Try it</a>
          <a href="#/case-study">How it works</a>
        </nav>
      </header>
      <main>
        {page === 'home' && (
          <Home
            onPick={(s) => {
              setSetup(s);
              go('#/setup');
            }}
          />
        )}
        {page === 'setup' && setup && (
          <SetupPage
            setup={setup}
            onChange={setSetup}
            onRun={(r) => {
              setRun({ ...r, analysisId: newAnalysisId() });
              go('#/results');
            }}
          />
        )}
        {page === 'results' && setup && run && <Results setup={setup} run={run} onBack={() => go('#/setup')} />}
        {page === 'case' && <CaseStudy />}
      </main>
      <footer className="foot">
        Decision support, not a guarantee. Every number is labelled with where it comes from. No customer personal data is collected.
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- home
function Home({ onPick }: { onPick: (s: Setup) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const observed = PRESETS.find((p) => p.primary)!;
  const curio = PRESETS.find((p) => p.id === 'curio')!;

  const build = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<'build'>({ type: 'build', description: text, analysisId: newAnalysisId() });
      if (!r.result.ok) setMsg(r.result.message);
      else {
        const m: BuiltModel = r.result.model;
        onPick({ spec: m.spec, source: 'Your description', labels: ['Built from your description; check every value'], assumptions: [...m.problems, ...m.assumptions] });
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home">
      <h1>Find out what to change in your café's rush before you change it.</h1>
      <p className="lede">Rush Hour Lab simulates your morning rush, tests changes like moving a barista or batching food, and recommends only what passes a strict test.</p>
      <div className="cards">
        <div className="card">
          <h2>Try a real café</h2>
          <p>A Bay Area café. <Badge kind="OBSERVED">OBSERVED</Badge> {observed.labels[0]}.</p>
          <button className="primary" onClick={() => onPick({ spec: observed.build(), source: observed.title, labels: observed.labels, assumptions: [] })}>
            Try the observed café
          </button>
          <button className="secondary" onClick={() => onPick({ spec: curio.build(), source: curio.title, labels: curio.labels, assumptions: [] })}>
            Try Curio Coffee (reconstructed)
          </button>
        </div>
        <div className="card">
          <h2>Describe your café</h2>
          <p>Staff, orders per hour, how long drinks and food take. You check the result before anything runs.</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="One cashier, two baristas, one person on the waffle iron. About 45 orders an hour from 7 to 9. Waffles take about 6 minutes."
          />
          <button className="primary" disabled={busy || text.trim().length < 15} onClick={build}>
            {busy ? 'Reading your description…' : 'Build my café'}
          </button>
          {msg && <p className="note">{msg}</p>}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- setup
const STATIONS: Array<{ key: 'cashier' | 'barista' | 'kitchen' | 'handoff'; label: string }> = [
  { key: 'cashier', label: 'Cashiers' },
  { key: 'barista', label: 'Baristas' },
  { key: 'kitchen', label: 'Kitchen staff' },
  { key: 'handoff', label: 'Handoff staff' },
];
const TASKS: Array<{ key: 'order' | 'drink' | 'food' | 'handoff'; label: string }> = [
  { key: 'order', label: 'Taking an order' },
  { key: 'drink', label: 'Making a drink' },
  { key: 'food', label: 'Making food' },
  { key: 'handoff', label: 'Handing over' },
];

function SetupPage({ setup, onChange, onRun }: { setup: Setup; onChange: (s: Setup) => void; onRun: (r: { constraints: Constraints; costs: CostTable; useLlm: boolean }) => void }) {
  const { spec } = setup;
  const [constraints, setConstraints] = useState<Constraints>({ maxChanges: 2 });
  const [costs, setCosts] = useState<CostTable>(DEFAULT_COSTS);
  const [useLlm, setUseLlm] = useState(true);
  const edit = (f: (s: CafeSpec) => void) => {
    const s = structuredClone(spec);
    f(s);
    onChange({ ...setup, spec: s });
  };
  const perHour = (spec.arrivals.ratePerMin.reduce((a, b) => a + b, 0) / spec.arrivals.ratePerMin.length) * 60;
  const total = Object.values(spec.mix).reduce((a, b) => a + (b ?? 0), 0) || 1;

  return (
    <section>
      <h1>Check your café</h1>
      <p className="lede">
        {setup.labels.join('. ')}. Check the numbers, set your limits, then run. Nothing runs until you press the button.
      </p>
      {setup.assumptions.length > 0 && (
        <div className="panel">
          <h3>What we assumed</h3>
          <ul>{setup.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      <div className="grid2">
        <div className="panel">
          <h3>Staff on shift</h3>
          {STATIONS.filter((s) => s.key !== 'handoff' || spec.handoff === 'dedicated').map((s) => {
            const w = spec.staff[s.key] === undefined ? null : toWindows(spec.staff[s.key]!);
            return (
              <label key={s.key} className="row">
                <span>{s.label}</span>
                {w && w.length > 1 ? (
                  <em>changes during the rush</em>
                ) : (
                  <input type="number" min={1} max={10} value={w ? w[0].servers : 0} onChange={(e) => edit((x) => (x.staff[s.key] = Math.max(1, Number(e.target.value))))} />
                )}
              </label>
            );
          })}
          <label className="row">
            <span>Drinks + food</span>
            <select value={spec.prepMode} onChange={(e) => edit((x) => (x.prepMode = e.target.value as CafeSpec['prepMode']))}>
              <option value="parallel">made at the same time</option>
              <option value="sequential">drink first, then food</option>
            </select>
          </label>
        </div>
        <div className="panel">
          <h3>Rush</h3>
          <label className="row">
            <span>Orders per hour (average)</span>
            <input type="number" min={1} max={600} value={Math.round(perHour)} onChange={(e) => {
              const f = Number(e.target.value) / perHour;
              if (f > 0) edit((x) => (x.arrivals = { ...x.arrivals, ratePerMin: x.arrivals.ratePerMin.map((r) => r * f) }));
            }} />
          </label>
          <p className="small">{windowMinutes(spec.arrivals)}-minute rush{spec.startsAt ? ` from ${spec.startsAt}` : ''}. Order mix: {(Object.entries(spec.mix) as Array<[OrderType, number]>).filter(([, v]) => v > 0).map(([k, v]) => `${ORDER_TYPE_LABEL[k].toLowerCase()} ${Math.round((v / total) * 100)}%`).join(', ')}.</p>
          <h3>Typical minutes per task</h3>
          {TASKS.map((t) => {
            const d = spec.times[t.key];
            const v = d.kind === 'lognormal' ? d.median : d.kind === 'exponential' ? d.mean : d.value;
            return (
              <label key={t.key} className="row">
                <span>{t.label}</span>
                <input type="number" min={0.1} max={60} step={0.1} value={Math.round(v * 10) / 10} onChange={(e) => edit((x) => (x.times[t.key] = lognormal(Math.max(0.1, Number(e.target.value)), d.kind === 'lognormal' ? d.sigma : 0.4)))} />
              </label>
            );
          })}
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <h3>Your limits</h3>
          <label className="row check"><input type="checkbox" checked={!!constraints.noNewHires} onChange={(e) => setConstraints({ ...constraints, noNewHires: e.target.checked })} /> <span>No new hires (people can move between stations)</span></label>
          <label className="row"><span>Most changes at once</span><input type="number" min={1} max={4} value={constraints.maxChanges ?? 2} onChange={(e) => setConstraints({ ...constraints, maxChanges: Number(e.target.value) })} /></label>
          <label className="row"><span>Budget for the first month (optional)</span><input type="number" min={0} step={50} placeholder="no limit" value={constraints.budgetUsd ?? ''} onChange={(e) => setConstraints({ ...constraints, budgetUsd: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
          <label className="row check"><input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> <span>Let the AI analyst propose ideas too</span></label>
        </div>
        <div className="panel">
          <h3>Costs <Badge kind="ASSUMPTION" /></h3>
          <p className="small">{DEFAULT_COSTS_PROVENANCE}</p>
          {([
            ['staffHourly', 'Staff, per hour'],
            ['rushDaysPerMonth', 'Rush days per month'],
            ['grabGoSetup', 'Grab-and-go setup'],
            ['dedicatedHandoffSetup', 'Handoff point setup'],
            ['expressDrinksSetup', 'Express drink station setup'],
            ['foodBatching', 'Food batching setup'],
          ] as Array<[keyof CostTable, string]>).map(([k, label]) => (
            <label key={k} className="row"><span>{label}</span><input type="number" min={0} value={costs[k]} onChange={(e) => setCosts({ ...costs, [k]: Number(e.target.value) })} /></label>
          ))}
        </div>
      </div>
      <button className="primary big" onClick={() => onRun({ constraints, costs, useLlm })}>Run the analysis</button>
    </section>
  );
}

// ---------------------------------------------------------------- results
function Results({ setup, run, onBack }: { setup: Setup; run: { constraints: Constraints; costs: CostTable; useLlm: boolean; analysisId: string }; onBack: () => void }) {
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>({ phase: 'Starting', done: 0, total: 1 });
  const [data, setData] = useState<{ result: HybridResult; before: ResultSummary; after: ResultSummary | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    call<'recommend'>({ type: 'recommend', spec: setup.spec, constraints: run.constraints, costs: run.costs, useLlm: run.useLlm, analysisId: run.analysisId }, setProgress)
      .then((r) => setData(r))
      .catch((e) => setError(e.message))
      .finally(() => setProgress(null));
  }, [setup, run]);

  if (error) return <section><h1>Something went wrong</h1><p>{error}</p><button onClick={onBack}>Back</button></section>;
  if (!data)
    return (
      <section>
        <h1>Running your café…</h1>
        <p className="lede">{progress?.phase}</p>
        <div className="bar"><div style={{ width: `${progress && progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 5}%` }} /></div>
        <p className="small">Everything runs in your browser. Brute-force searches can take up to half a minute.</p>
      </section>
    );

  const { result, before, after } = data;
  const rec = result.recommended;
  const isObserved = setup.source === PRESETS[0].title;
  return (
    <section>
      <p className="disclaimer">Decision support, not a guarantee. All waits below are <Badge kind="SIMULATED" />{isObserved ? ' from a model calibrated on 18 observed orders from one session' : ''}.</p>
      <h1>{rec ? 'Recommended change' : 'No change passed the test'}</h1>
      {rec ? (
        <div className="panel hero">
          <p className="plan">{planText(rec)}</p>
          <p>
            Bad-case (90th percentile) wait {min(rec.verification.baseP90)} → {min(rec.verification.candidateP90)}, <strong>{pct(rec.verification.improvement)} shorter</strong>. First-month cost about {money(rec.record.costUsd)} <Badge kind="ASSUMPTION">cost assumption</Badge>.
          </p>
          <p className="small">
            Found by: {rec.foundBy.map((m) => <Badge key={m} kind="method">{m}</Badge>)} · Passed the test during the search and again on {rec.verification.reps.toLocaleString('en-US')} fresh simulated rushes <Badge kind="ok">verified</Badge>
          </p>
        </div>
      ) : (
        <div className="panel hero">
          <p>We tested {result.plans.length} plans. None cut the bad-case wait by at least 10% in a way that held up. That is a real answer: the changes we can simulate would not reliably help.</p>
        </div>
      )}
      {Object.entries(before.stations).some(([, s]) => (s.utilization ?? 0) >= 0.95) && (
        <p className="note">
          Today the {Object.entries(before.stations).filter(([, s]) => (s.utilization ?? 0) >= 0.95).map(([id]) => id).join(' and ')} cannot keep up: busy{' '}
          {Object.entries(before.stations).filter(([, s]) => (s.utilization ?? 0) >= 0.95).map(([, s]) => `${Math.round((s.utilization ?? 0) * 100)}%`).join(' and ')} of the time, so the queue keeps growing through the rush. That is why today's waits are so long. Check that the orders per hour and task times are right.
        </p>
      )}
      {isObserved && (
        <p className="note">This model's drink + food waits run about 5.6 min shorter than the 5 observed drink + food orders (possibly one group order). Treat drink + food numbers as optimistic.</p>
      )}

      <h2>Before and after</h2>
      <BeforeAfter before={before} after={after} />

      {rec && (
        <>
          <h2>Why we recommend it</h2>
          <p className="small">The acceptance test, as run during the search ({'150'} simulated rushes per plan).</p>
          <ul className="checks">
            {rec.record.decision!.checks.map((c) => (
              <li key={c.name}><Badge kind={c.passed ? 'ok' : 'no'}>{c.passed ? 'pass' : 'fail'}</Badge> <strong>{c.name}.</strong> {c.detail}</li>
            ))}
          </ul>
        </>
      )}

      <h2>Tested and rejected</h2>
      <Rejected plans={result.plans} recommendedKey={rec?.key} failedVerification={result.failedVerification} />
      <p className="small">
        Search: {result.searchMethod.toLowerCase()} over {result.plans.length} plans ({result.simulations.toLocaleString('en-US')} simulation batches).
        {result.agent.ran ? ` The AI analyst also ran ${result.agent.steps.filter((s) => s.kind === 'experiment').length} experiments (${result.agent.llmCalls} AI calls).` : run.useLlm ? ` The AI analyst was not available, so only code search ran${result.agent.error ? ` (${result.agent.error.replace(/\.$/, '')})` : ''}.` : ''}
      </p>

      {result.agent.ran && <AgentSteps result={result} />}
      <WhatIf spec={setup.spec} analysisId={run.analysisId} />
      <button className="secondary" onClick={onBack}>Change the café or limits</button>
    </section>
  );
}

function BeforeAfter({ before, after }: { before: ResultSummary; after: ResultSummary | null }) {
  const types = (Object.keys(before.byType) as OrderType[]).filter((t) => before.byType[t]);
  const rows: Array<[string, Interval | undefined, Interval | undefined]> = [
    ['Bad-case wait (90th percentile), all orders', before.overall.p90, after?.overall.p90],
    ['Typical wait (median), all orders', before.overall.median, after?.overall.median],
    ...types.map((t) => [`Bad-case wait, ${ORDER_TYPE_LABEL[t].toLowerCase()}`, before.byType[t]!.p90, after?.byType[t]?.p90] as [string, Interval, Interval | undefined]),
    ['Time in café (90th percentile, includes the order line)', before.timeInCafe.p90, after?.timeInCafe.p90],
  ];
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th></th><th>Today</th><th>With the change</th></tr></thead>
        <tbody>
          {rows.map(([label, b, a]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{min(b?.mean)} <span className="ci">{ci(b)}</span></td>
              <td>{after ? <>{min(a?.mean)} <span className="ci">{ci(a)}</span></> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small"><Badge kind="SIMULATED" /> Mean over {before.reps} simulated rushes, with 95% confidence intervals (simulation noise only). "Wait" runs from placing the order to receiving it.</p>
    </div>
  );
}

function Rejected({ plans, recommendedKey, failedVerification }: { plans: TestedPlan[]; recommendedKey?: string; failedVerification: HybridResult['failedVerification'] }) {
  const failedKeys = new Set(failedVerification.map((f) => f.key));
  const rows = plans
    .filter((p) => p.key !== recommendedKey)
    .sort((a, b) => (b.record.evidence?.nominal.improvement ?? -9) - (a.record.evidence?.nominal.improvement ?? -9))
    .slice(0, 10);
  return (
    <div className="tablewrap">
      <table>
        <thead><tr><th>Plan</th><th>Bad-case wait</th><th>Why not</th></tr></thead>
        <tbody>
          {rows.map((p) => {
            const e = p.record.evidence?.nominal;
            const why = failedKeys.has(p.key)
              ? 'Passed the search but not the fresh re-check (improvement fell under 10%)'
              : p.record.status === 'blocked' || p.record.status === 'invalid'
                ? p.record.violations.join('; ')
                : p.record.status === 'accepted'
                  ? 'Passed, but another plan helps more'
                  : p.record.decision!.checks.filter((c) => !c.passed).map((c) => c.name).join('; ');
            return (
              <tr key={p.key}>
                <td>{planText(p)}</td>
                <td>{e ? `${min(e.candidateP90)} (${e.improvement >= 0 ? pct(e.improvement) + ' shorter' : pct(e.improvement) + ' longer'})` : 'not simulated'}</td>
                <td>{why}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentSteps({ result }: { result: HybridResult }) {
  const steps = result.agent.steps.filter((s) => s.kind === 'experiment' || s.kind === 'stop');
  return (
    <details className="panel">
      <summary>AI analyst's steps ({steps.length})</summary>
      <ol className="steps">
        {steps.map((s, i) =>
          s.kind === 'experiment' ? (
            <li key={i}>
              <p><em>Hypothesis (the AI's guess, not a result):</em> {s.experiment.hypothesis || '—'}</p>
              <p>Tested: {s.experiment.descriptions.join(' + ')} → <Badge kind={s.experiment.status === 'accepted' ? 'ok' : 'no'}>{s.experiment.status}</Badge>{' '}
                {s.experiment.evidence ? `${min(s.experiment.evidence.nominal.baseP90)} → ${min(s.experiment.evidence.nominal.candidateP90)}` : s.experiment.violations.join('; ')}</p>
            </li>
          ) : s.kind === 'stop' ? <li key={i}><p>{s.message}</p></li> : null,
        )}
      </ol>
      {result.agent.summary && <p><em>AI summary:</em> {result.agent.summary}</p>}
    </details>
  );
}

function WhatIf({ spec, analysisId }: { spec: CafeSpec; analysisId: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Array<{ q: string; r: WhatIfResult }>>([]);
  const ask = async () => {
    setBusy(true);
    try {
      const r = await call<'whatIf'>({ type: 'whatIf', spec, question: q, analysisId });
      setAnswers([{ q, r: r.result }, ...answers]);
      setQ('');
    } finally {
      setBusy(false);
    }
  };
  const example = useMemo(() => (spec.startsAt ? `What if I add a barista for the busiest half hour?` : 'What if I add a barista?'), [spec.startsAt]);
  return (
    <div className="panel">
      <h2>What if…?</h2>
      <div className="ask">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={example} onKeyDown={(e) => e.key === 'Enter' && q.trim() && !busy && ask()} />
        <button className="primary" disabled={busy || !q.trim()} onClick={ask}>{busy ? 'Simulating…' : 'Ask'}</button>
      </div>
      {answers.map((a, i) => (
        <div key={i} className="answer">
          <p className="q">{a.q}</p>
          <p>{a.r.answer}</p>
          {a.r.explanation && <p className="small"><em>AI's note:</em> {a.r.explanation}</p>}
        </div>
      ))}
    </div>
  );
}
