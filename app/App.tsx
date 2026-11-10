import { useEffect, useRef, useState } from 'react';
import type { HybridResult, TestedPlan } from '../src/agent/hybrid';
import type { ResultSummary } from '../src/agent/evaluate';
import type { WhatIfResult } from '../src/agent/whatIf';
import type { BuiltModel } from '../src/agent/modelBuilder';
import { verdict } from '../src/agent/explain';
import { describeChange } from '../src/agent/changes';
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
function call<T extends WorkerResponse['type']>(req: NewRequest, onProgress?: (p: { phase: string; done: number; total: number }) => void): Promise<Extract<WorkerResponse, { type: T }>> {
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

// ---------------------------------------------------------------- formatting
const min = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(1));
const ci = (i: Interval | undefined) => (i && Number.isFinite(i.low) ? `${i.low.toFixed(1)}–${i.high.toFixed(1)}` : '');
const pct = (x: number) => `${Math.abs(x * 100).toFixed(0)}%`;
const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const planText = (p: TestedPlan) => p.record.descriptions.map((d, i) => (i === 0 ? d : d[0].toLowerCase() + d.slice(1))).join(', and ');

type Prov = 'OBSERVED' | 'SIMULATED' | 'ASSUMPTION';
const Tag = ({ kind, children }: { kind: Prov | 'method' | 'ok'; children?: React.ReactNode }) => <span className={`tag tag-${kind.toLowerCase()}`}>{children ?? kind}</span>;
const Spinner = () => <span className="spinner" aria-hidden="true" />;

// ---------------------------------------------------------------- routing
const STEPS = [
  { hash: '#/', label: 'Describe your café', short: 'Describe' },
  { hash: '#/confirm', label: 'Confirm the model', short: 'Confirm' },
  { hash: '#/recommendation', label: 'Recommendation', short: 'Result' },
  { hash: '#/what-ifs', label: 'What-ifs', short: 'What-ifs' },
] as const;

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => {
      setHash(location.hash || '#/');
      scrollTo({ top: 0 });
    };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return [hash, (h) => (location.hash = h)];
}

interface Setup {
  spec: CafeSpec;
  source: string;
  labels: string[];
  assumptions: string[];
  observed: boolean;
}
interface Run {
  constraints: Constraints;
  costs: CostTable;
  useLlm: boolean;
  analysisId: string;
}
interface Analysis {
  result: HybridResult;
  before: ResultSummary;
  after: ResultSummary | null;
}

// ---------------------------------------------------------------- app
export function App() {
  const [hash, go] = useHash();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);

  const isCase = hash.startsWith('#/case-study');
  let step = 0;
  if (hash.startsWith('#/confirm') && setup) step = 1;
  else if (hash.startsWith('#/recommendation') && setup && run) step = 2;
  else if (hash.startsWith('#/what-ifs') && setup && run) step = 3;
  const reachable = [true, !!setup, !!setup && !!run, !!setup && !!run && !!analysis];

  return (
    <div className="page">
      <header className="masthead">
        <a href="#/" className="brand" aria-label="Rush Hour Lab, start">
          <span className="brand-mark" aria-hidden="true">RH</span>
          <span>Rush Hour Lab</span>
        </a>
        <nav className="topnav">
          <a href="#/" aria-current={!isCase ? 'page' : undefined}>Try it</a>
          <a href="#/case-study" aria-current={isCase ? 'page' : undefined}>How it works</a>
        </nav>
      </header>

      {!isCase && <Stepper current={step} reachable={reachable} />}

      <main className="main">
        {isCase && <CaseStudy />}
        {!isCase && step === 0 && (
          <Describe
            onPick={(s) => {
              setSetup(s);
              setRun(null);
              setAnalysis(null);
              setAnswers([]);
              go('#/confirm');
            }}
          />
        )}
        {!isCase && step === 1 && setup && (
          <Confirm
            setup={setup}
            onChange={(s) => {
              setSetup(s);
              setAnalysis(null);
            }}
            onRun={(r) => {
              setRun({ ...r, analysisId: newAnalysisId() });
              setAnalysis(null);
              setAnswers([]);
              go('#/recommendation');
            }}
          />
        )}
        {!isCase && step === 2 && setup && run && (
          <Recommendation setup={setup} run={run} analysis={analysis} onDone={setAnalysis} onNext={() => go('#/what-ifs')} onBack={() => go('#/confirm')} />
        )}
        {!isCase && step === 3 && setup && run && <WhatIfs setup={setup} run={run} analysis={analysis} answers={answers} setAnswers={setAnswers} />}
      </main>

      <footer className="footer">
        <p>Decision support, not a guarantee. Every number is labelled with where it comes from. No customer personal data is collected.</p>
      </footer>
    </div>
  );
}

function Stepper({ current, reachable }: { current: number; reachable: boolean[] }) {
  return (
    <nav className="rail" aria-label="Steps">
      <ol>
        {STEPS.map((s, i) => {
          const state = i === current ? 'current' : i < current ? 'done' : 'todo';
          const inner = (
            <>
              <span className="rail-num">{state === 'done' ? '✓' : i + 1}</span>
              <span className="rail-label"><span className="long">{s.label}</span><span className="short" aria-hidden="true">{s.short}</span></span>
            </>
          );
          return (
            <li key={s.hash} className={`rail-step ${state}`}>
              {reachable[i] && i !== current ? <a href={s.hash}>{inner}</a> : <span aria-current={i === current ? 'step' : undefined}>{inner}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------- step 1
function Describe({ onPick }: { onPick: (s: Setup) => void }) {
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
      if (!r.result.ok) setMsg(`${r.result.message} You can also start from an example below.`);
      else {
        const m: BuiltModel = r.result.model;
        onPick({ spec: m.spec, source: 'Your café', labels: ['Built from your description. Check every value.'], assumptions: [...m.problems, ...m.assumptions], observed: false });
      }
    } catch (e) {
      setMsg(`${(e as Error).message} You can also start from an example below.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack-lg">
      <div className="intro">
        <h1>Find the one change that shortens your morning queue.</h1>
        <p className="lede">Describe your rush. We simulate it, test every change you could make, and recommend only what holds up.</p>
      </div>
      <div className="split">
        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && text.trim().length >= 15) build();
          }}
        >
          <label htmlFor="describe" className="h3">Tell us about your rush</label>
          <textarea
            id="describe"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="One cashier, two baristas, one person on the waffle iron. About 45 orders an hour from 7 to 9. Waffles take about 6 minutes."
          />
          <p className="hint">Staff at each station, orders per hour, when the rush starts and how long drinks and food take. You check everything before it runs.</p>
          <button type="submit" className="btn btn-primary" disabled={busy || text.trim().length < 15}>
            {busy ? <><Spinner /> Reading your description…</> : 'Build my café model'}
          </button>
          {msg && <p className="callout" role="status">{msg}</p>}
        </form>
        <div className="panel stack examples">
          <h2 className="h3">Or start from an example</h2>
          <button className="example" onClick={() => onPick({ spec: observed.build(), source: 'A Bay Area café', labels: observed.labels, assumptions: [], observed: true })}>
            <span className="example-title">A Bay Area café <Tag kind="OBSERVED" /></span>
            <span className="example-body">Calibrated on 18 orders timed at a real café. 1 cashier, 1 barista, 1 cook.</span>
          </button>
          <button className="example" onClick={() => onPick({ spec: curio.build(), source: 'Curio Coffee', labels: curio.labels, assumptions: [], observed: false })}>
            <span className="example-title">Curio Coffee</span>
            <span className="example-body">A busy waffle café, reconstructed from a 2025 class proposal. 300 orders in two hours.</span>
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- step 2
const STATIONS = [
  { key: 'cashier', label: 'Cashiers' },
  { key: 'barista', label: 'Baristas' },
  { key: 'kitchen', label: 'Kitchen staff' },
  { key: 'handoff', label: 'Pickup staff' },
] as const;
const TASKS = [
  { key: 'order', label: 'Taking an order' },
  { key: 'drink', label: 'Making a drink' },
  { key: 'food', label: 'Making food' },
  { key: 'handoff', label: 'Handing over' },
] as const;

function Confirm({ setup, onChange, onRun }: { setup: Setup; onChange: (s: Setup) => void; onRun: (r: Omit<Run, 'analysisId'>) => void }) {
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
  const mix = (Object.entries(spec.mix) as Array<[OrderType, number]>).filter(([, v]) => v > 0);

  return (
    <section className="stack-lg">
      <div className="intro">
        <p className="eyebrow">{setup.source}</p>
        <h1>Check the model of your rush</h1>
        <p className="lede">{setup.labels.map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)).join(' ')} Change anything that looks wrong, set your limits, then find the best change.</p>
      </div>

      {setup.assumptions.length > 0 && (
        <details className="panel" open>
          <summary className="h3">What we had to assume ({setup.assumptions.length})</summary>
          <ul className="list">{setup.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      )}

      <div className="grid-2">
        <fieldset className="panel stack">
          <legend className="h3">Staff on shift</legend>
          {STATIONS.filter((s) => s.key !== 'handoff' || spec.handoff === 'dedicated').map((s) => {
            const w = spec.staff[s.key] === undefined ? null : toWindows(spec.staff[s.key]!);
            const id = `staff-${s.key}`;
            return (
              <div key={s.key} className="field">
                <label htmlFor={id}>{s.label}</label>
                {w && w.length > 1 ? (
                  <em className="hint">changes during the rush</em>
                ) : (
                  <Stepper2 id={id} value={w ? w[0].servers : 0} min={1} max={10} onChange={(v) => edit((x) => (x.staff[s.key] = v))} />
                )}
              </div>
            );
          })}
          <div className="field">
            <label htmlFor="prep">Drink + food orders</label>
            <select id="prep" value={spec.prepMode} onChange={(e) => edit((x) => (x.prepMode = e.target.value as CafeSpec['prepMode']))}>
              <option value="parallel">made at the same time</option>
              <option value="sequential">drink first, then food</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="panel stack">
          <legend className="h3">The rush</legend>
          <div className="field">
            <label htmlFor="perhour">Orders per hour (average)</label>
            <input id="perhour" type="number" inputMode="numeric" min={1} max={600} value={Math.round(perHour)} onChange={(e) => {
              const f = Number(e.target.value) / perHour;
              if (f > 0) edit((x) => (x.arrivals = { ...x.arrivals, ratePerMin: x.arrivals.ratePerMin.map((r) => r * f) }));
            }} />
          </div>
          <p className="hint">{windowMinutes(spec.arrivals)}-minute rush{spec.startsAt ? ` from ${spec.startsAt}` : ''}. Orders: {mix.map(([k, v]) => `${ORDER_TYPE_LABEL[k].toLowerCase()} ${Math.round((v / total) * 100)}%`).join(', ')}.</p>
          <p className="h4">Typical minutes per task</p>
          {TASKS.map((t) => {
            const d = spec.times[t.key];
            const v = d.kind === 'lognormal' ? d.median : d.kind === 'exponential' ? d.mean : d.value;
            const id = `time-${t.key}`;
            return (
              <div key={t.key} className="field">
                <label htmlFor={id}>{t.label}</label>
                <input id={id} type="number" inputMode="decimal" min={0.1} max={60} step={0.1} value={Math.round(v * 10) / 10} onChange={(e) => edit((x) => (x.times[t.key] = lognormal(Math.max(0.1, Number(e.target.value)), d.kind === 'lognormal' ? d.sigma : 0.4)))} />
              </div>
            );
          })}
        </fieldset>
      </div>

      <fieldset className="panel stack">
        <legend className="h3">Your limits</legend>
        <div className="grid-2 tight">
          <label className="check" htmlFor="nohires">
            <input id="nohires" type="checkbox" checked={!!constraints.noNewHires} onChange={(e) => setConstraints({ ...constraints, noNewHires: e.target.checked })} />
            <span>No new hires <span className="hint">(people can move between stations)</span></span>
          </label>
          <label className="check" htmlFor="usellm">
            <input id="usellm" type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />
            <span>Let the AI analyst suggest ideas too</span>
          </label>
          <div className="field">
            <label htmlFor="maxchanges">Most changes at once</label>
            <Stepper2 id="maxchanges" value={constraints.maxChanges ?? 2} min={1} max={4} onChange={(v) => setConstraints({ ...constraints, maxChanges: v })} />
          </div>
          <div className="field">
            <label htmlFor="budget">Budget, first month</label>
            <input id="budget" type="number" inputMode="numeric" min={0} step={50} placeholder="No limit" value={constraints.budgetUsd ?? ''} onChange={(e) => setConstraints({ ...constraints, budgetUsd: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </div>
        </div>
        <details>
          <summary>Costs used for the budget <Tag kind="ASSUMPTION" /></summary>
          <p className="hint">{DEFAULT_COSTS_PROVENANCE}</p>
          <div className="grid-2 tight">
            {([
              ['staffHourly', 'Staff, per hour'],
              ['rushDaysPerMonth', 'Rush days per month'],
              ['grabGoSetup', 'Grab-and-go setup'],
              ['dedicatedHandoffSetup', 'Pickup counter setup'],
              ['expressDrinksSetup', 'Express drink station'],
              ['foodBatching', 'Food batching setup'],
            ] as Array<[keyof CostTable, string]>).map(([k, label]) => (
              <div key={k} className="field">
                <label htmlFor={`cost-${k}`}>{label}</label>
                <input id={`cost-${k}`} type="number" inputMode="numeric" min={0} value={costs[k]} onChange={(e) => setCosts({ ...costs, [k]: Number(e.target.value) })} />
              </div>
            ))}
          </div>
        </details>
      </fieldset>

      <div className="actions">
        <button className="btn btn-primary btn-lg" onClick={() => onRun({ constraints, costs, useLlm })}>Find the best change</button>
        <a className="btn btn-secondary" href="#/">Start over</a>
      </div>
    </section>
  );
}

/** − n + control with 44px targets. */
function Stepper2({ id, value, min: lo, max: hi, onChange }: { id: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="counter">
      <button type="button" className="counter-btn" aria-label="Fewer" disabled={value <= lo} onClick={() => onChange(Math.max(lo, value - 1))}>−</button>
      <input id={id} type="number" inputMode="numeric" min={lo} max={hi} value={value} onChange={(e) => onChange(Math.min(hi, Math.max(lo, Number(e.target.value) || lo)))} />
      <button type="button" className="counter-btn" aria-label="More" disabled={value >= hi} onClick={() => onChange(Math.min(hi, value + 1))}>+</button>
    </div>
  );
}

// ---------------------------------------------------------------- step 3
function Recommendation({ setup, run, analysis, onDone, onNext, onBack }: { setup: Setup; run: Run; analysis: Analysis | null; onDone: (a: Analysis) => void; onNext: () => void; onBack: () => void }) {
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number }>({ phase: 'Simulating your rush as it is today', done: 0, total: 1 });
  const [error, setError] = useState<string | null>(null);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (analysis || started.current === run.analysisId) return;
    started.current = run.analysisId;
    call<'recommend'>({ type: 'recommend', spec: setup.spec, constraints: run.constraints, costs: run.costs, useLlm: run.useLlm, analysisId: run.analysisId }, setProgress)
      .then((r) => onDone({ result: r.result, before: r.before, after: r.after }))
      .catch((e) => setError(e.message));
  }, [setup, run, analysis, onDone]);

  if (error)
    return (
      <section className="stack">
        <h1>The simulation stopped</h1>
        <p className="callout">{error}</p>
        <button className="btn btn-secondary" onClick={onBack}>Back to the model</button>
      </section>
    );
  if (!analysis) return <Working progress={progress} />;

  const { result, before, after } = analysis;
  const rec = result.recommended;
  const overloaded = Object.entries(before.stations).filter(([, s]) => (s.utilization ?? 0) >= 0.95);
  return (
    <section className="stack-lg">
      {rec ? <TicketCard rec={rec} /> : <NoChangeCard tested={result.plans.length} />}

      <div className="actions">
        <button className="btn btn-primary btn-lg" onClick={onNext}>Next: try your own what-ifs</button>
        <button className="btn btn-secondary" onClick={onBack}>Change the model or limits</button>
      </div>

      <p className="disclaimer"><Tag kind="SIMULATED" /> Decision support, not a guarantee.{setup.observed ? ' This café was calibrated on 18 observed orders from one session; its drink + food waits run about 5.6 min short of what was observed, so treat those as optimistic.' : ''}</p>
      {overloaded.length > 0 && (
        <p className="callout">Today the {overloaded.map(([id]) => id).join(' and ')} cannot keep up (busy {overloaded.map(([, s]) => pct(s.utilization ?? 0)).join(' and ')} of the time), so the queue keeps growing through the rush. Check the orders per hour and task times if that seems wrong.</p>
      )}

      <section className="stack">
        <h2>Before and after</h2>
        <BeforeAfter before={before} after={after} />
      </section>

      {rec && (
        <details className="panel">
          <summary className="h3">Why this change passed (all 7 checks)</summary>
          <Checks plan={rec} />
        </details>
      )}

      <section className="stack">
        <h2>Tested and rejected</h2>
        <Rejected plans={result.plans} recommendedKey={rec?.key} failedVerification={result.failedVerification} />
        <p className="hint">
          {result.searchMethod === 'Brute force' ? 'Every combination' : 'A step-by-step search'} of {result.plans.length} possible changes, tested on the same simulated customers.
          {result.agent.ran ? ` The AI analyst also tested ${result.agent.steps.filter((s) => s.kind === 'experiment').length} ideas of its own.` : run.useLlm ? ' The AI analyst was not available, so only the code search ran.' : ''}
        </p>
      </section>

      {result.agent.ran && <AgentSteps result={result} />}
    </section>
  );
}

function Working({ progress }: { progress: { phase: string; done: number; total: number } }) {
  const share = progress.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <section className="stack-lg" aria-busy="true">
      <div className="ticket ticket-skeleton" aria-hidden="true">
        <div className="ticket-head"><span>Order up</span><span>—</span></div>
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
      <div className="stack" role="status" aria-live="polite">
        <p className="h3"><Spinner /> {progress.phase}…</p>
        <div className="bar"><div style={{ width: `${Math.max(4, share * 100)}%` }} /></div>
        <p className="hint">Everything runs in your browser. Testing every combination can take up to half a minute.</p>
      </div>
    </section>
  );
}

function TicketCard({ rec }: { rec: NonNullable<HybridResult['recommended']> }) {
  const v = rec.verification;
  return (
    <article className="ticket" aria-labelledby="rec-title">
      <div className="ticket-head">
        <span>Recommended change</span>
        <span>Found by {rec.foundBy.map((f) => (f === 'LLM agent' ? 'AI analyst' : f.toLowerCase())).join(' + ')}</span>
      </div>
      <h1 id="rec-title" className="ticket-title">{planText(rec)}</h1>
      <div className="ticket-numbers" aria-label={`Bad-case wait from ${min(v.baseP90)} to ${min(v.candidateP90)} minutes`}>
        <div>
          <span className="num-label">Bad-case wait today</span>
          <span className="num num-before"><s>{min(v.baseP90)}</s><small>min</small></span>
        </div>
        <span className="num-arrow" aria-hidden="true">→</span>
        <div>
          <span className="num-label">With this change</span>
          <span className="num num-after">{min(v.candidateP90)}<small>min</small></span>
        </div>
        <div className="num-delta">{pct(v.improvement)} shorter</div>
      </div>
      <div className="ticket-foot">
        <span className="verified">✓ Verified on {v.reps.toLocaleString('en-US')} simulated rushes</span>
        <span>About {money(rec.record.costUsd)} in the first month <Tag kind="ASSUMPTION">cost estimate</Tag></span>
      </div>
      <p className="ticket-note">Bad-case wait is the 90th percentile: 1 in 10 customers waits longer than this, from ordering to pickup.</p>
    </article>
  );
}

function NoChangeCard({ tested }: { tested: number }) {
  return (
    <article className="ticket">
      <div className="ticket-head"><span>No change recommended</span><span>{tested} tested</span></div>
      <h1 className="ticket-title">Nothing we can simulate would reliably cut your wait.</h1>
      <p className="ticket-note">None of the {tested} changes cut the bad-case wait by at least 10% in a way that held up on a second, larger simulation. That is a real answer: keep your money. Try a what-if to explore anyway.</p>
    </article>
  );
}

function BeforeAfter({ before, after }: { before: ResultSummary; after: ResultSummary | null }) {
  const types = (Object.keys(before.byType) as OrderType[]).filter((t) => before.byType[t]);
  const rows: Array<[string, Interval | undefined, Interval | undefined, boolean?]> = [
    ['Bad-case wait, all orders', before.overall.p90, after?.overall.p90, true],
    ['Typical wait, all orders', before.overall.median, after?.overall.median],
    ...types.map((t) => [`Bad-case wait, ${ORDER_TYPE_LABEL[t].toLowerCase()}`, before.byType[t]!.p90, after?.byType[t]?.p90] as [string, Interval, Interval | undefined]),
    ['Time in café, bad case (includes the order line)', before.timeInCafe.p90, after?.timeInCafe.p90],
  ];
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th scope="col">Minutes</th><th scope="col">Today</th><th scope="col">With the change</th></tr></thead>
        <tbody>
          {rows.map(([label, b, a, strong]) => (
            <tr key={label} className={strong ? 'row-strong' : undefined}>
              <th scope="row">{label}</th>
              <td><span className="mono">{min(b?.mean)}</span> <span className="ci">{ci(b)}</span></td>
              <td>{after ? <><span className="mono">{min(a?.mean)}</span> <span className="ci">{ci(a)}</span></> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Average of {before.reps.toLocaleString('en-US')} simulated rushes; small numbers are 95% ranges for simulation noise. Wait runs from placing the order to receiving it.</p>
    </div>
  );
}

function Checks({ plan }: { plan: TestedPlan }) {
  if (!plan.record.decision) return <p className="hint">{verdict(plan.record).sentence}</p>;
  return (
    <ul className="checks">
      {plan.record.decision.checks.map((c) => (
        <li key={c.name} className={c.passed ? 'pass' : 'fail'}>
          <span className="check-mark" aria-label={c.passed ? 'passed' : 'failed'}>{c.passed ? '✓' : '✗'}</span>
          <span><strong>{c.name}.</strong> {c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Rejected({ plans, recommendedKey, failedVerification }: { plans: TestedPlan[]; recommendedKey?: string; failedVerification: HybridResult['failedVerification'] }) {
  const failedKeys = new Set(failedVerification.map((f) => f.key));
  const byGain = (a: TestedPlan, b: TestedPlan) => (b.record.evidence?.nominal.improvement ?? -9) - (a.record.evidence?.nominal.improvement ?? -9);
  const others = plans.filter((p) => p.key !== recommendedKey);
  const rejected = others.filter((p) => p.record.status !== 'accepted' || failedKeys.has(p.key)).sort(byGain);
  const alsoPassed = others.filter((p) => p.record.status === 'accepted' && !failedKeys.has(p.key)).sort(byGain);
  const row = (p: TestedPlan) => {
    const v = failedKeys.has(p.key) ? { kind: 'rejected' as const, sentence: '✗ Rejected: passed at first, but not on the second, larger simulation.' } : verdict(p.record);
    return (
      <li key={p.key} className={`rej rej-${v.kind}`}>
        <p className="rej-plan">{planText(p)}</p>
        <p className="rej-why">{v.sentence}</p>
        {p.record.decision && (
          <details>
            <summary>Details</summary>
            <Checks plan={p} />
          </details>
        )}
      </li>
    );
  };
  return (
    <div className="stack">
      {rejected.length ? <ul className="rejected">{rejected.slice(0, 8).map(row)}</ul> : <p className="hint">Nothing was rejected.</p>}
      {rejected.length > 8 && <p className="hint">Showing the 8 closest of {rejected.length} rejected changes.</p>}
      {alsoPassed.length > 0 && (
        <details className="panel">
          <summary className="h3">{alsoPassed.length} other {alsoPassed.length === 1 ? 'change' : 'changes'} also passed, but helped less</summary>
          <ul className="rejected flush">{alsoPassed.slice(0, 8).map(row)}</ul>
        </details>
      )}
    </div>
  );
}

function AgentSteps({ result }: { result: HybridResult }) {
  const exps = result.agent.steps.filter((s) => s.kind === 'experiment');
  return (
    <details className="panel">
      <summary className="h3">The AI analyst's experiments ({exps.length})</summary>
      <ol className="list">
        {exps.map((s, i) =>
          s.kind === 'experiment' ? (
            <li key={i}>
              <p><em>Its guess, not a result:</em> {s.experiment.hypothesis || '—'}</p>
              <p>{s.experiment.descriptions.join(', and ')}: {verdict(s.experiment).sentence.replace('✓ Passed every check, but another plan cuts the bad-case wait more.', '✓ Passed.')}</p>
            </li>
          ) : null,
        )}
      </ol>
      {result.agent.summary && <p><em>Its summary:</em> {result.agent.summary}</p>}
    </details>
  );
}

// ---------------------------------------------------------------- step 4
const EXAMPLES = ['What if I add a barista 8–9am?', 'What if we batch the waffles?', 'Move a cashier to the kitchen', 'What if 30% of drinks were grab-and-go?'];

type Answer = { q: string; r: WhatIfResult };

function WhatIfs({ setup, run, analysis, answers, setAnswers }: { setup: Setup; run: Run; analysis: Analysis | null; answers: Answer[]; setAnswers: React.Dispatch<React.SetStateAction<Answer[]>> }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ(question);
    try {
      const r = await call<'whatIf'>({ type: 'whatIf', spec: setup.spec, question, analysisId: run.analysisId, constraints: run.constraints, costs: run.costs, useLlm: run.useLlm });
      setAnswers((a) => [{ q: question, r: r.result }, ...a]);
      setQ('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack-lg">
      <div className="intro">
        <h1>Try your own what-ifs</h1>
        <p className="lede">Ask in your own words. We change the model, rerun the same simulated rush and show what happens, including whether it fits your limits.</p>
      </div>
      {analysis?.result.recommended && (
        <p className="hint">Recommended so far: <strong>{planText(analysis.result.recommended)}</strong>. <a href="#/recommendation">Back to the recommendation</a></p>
      )}
      <form className="panel stack" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <label htmlFor="whatif" className="h3">Your question</label>
        <div className="ask">
          <input id="whatif" value={q} onChange={(e) => setQ(e.target.value)} placeholder="what if i add 2 more cooks 8-9am" autoComplete="off" />
          <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()}>{busy ? <><Spinner /> Simulating…</> : 'Ask'}</button>
        </div>
        <div className="chips" aria-label="Examples">
          {EXAMPLES.map((ex) => <button type="button" key={ex} className="chip" onClick={() => ask(ex)} disabled={busy}>{ex}</button>)}
        </div>
      </form>
      {answers.map((a, i) => <WhatIfAnswer key={answers.length - i} q={a.q} r={a.r} spec={setup.spec} />)}
    </section>
  );
}

function WhatIfAnswer({ q, r, spec }: { q: string; r: WhatIfResult; spec: CafeSpec }) {
  const c = r.comparison;
  return (
    <article className="panel stack answer">
      <p className="answer-q">“{q}”</p>
      {!r.ok || !c ? (
        <p>{r.answer}</p>
      ) : (
        <>
          <p className="answer-plan">{r.changes.map((ch, i) => { const d = describeChange(ch, spec.startsAt); return i ? d[0].toLowerCase() + d.slice(1) : d; }).join(', and ')}</p>
          <div className="mini-numbers">
            <span className="mono">{min(c.baseP90)} → {min(c.candidateP90)} min</span>
            <span className={c.diff.mean >= 0 ? 'good' : 'bad'}>bad-case wait {pct(c.improvement)} {c.diff.mean >= 0 ? 'shorter' : 'longer'}</span>
            <span className="hint">time in café {min(c.timeInCafe.baseP90)} → {min(c.timeInCafe.candidateP90)} min</span>
          </div>
          {r.limits && (
            <div className="callout stack-sm">
              <p><strong>This breaks your limit.</strong> {r.limits.breaks.map((b) => b.message).join('. ')}.</p>
              {r.limits.suggestion ? (
                <p>Nearest change within your limits: <strong>{r.limits.suggestion.description}</strong>. Bad-case wait {min(r.limits.suggestion.comparison.baseP90)} → {min(r.limits.suggestion.comparison.candidateP90)} min ({pct(r.limits.suggestion.comparison.improvement)} {r.limits.suggestion.comparison.diff.mean >= 0 ? 'shorter' : 'longer'}).</p>
              ) : (
                <p>I could not find a similar change within your limits.</p>
              )}
            </div>
          )}
          {r.notes.length > 0 && <p className="hint">{r.notes.join(' ')}</p>}
          <p className="hint"><Tag kind="SIMULATED" /> Read by {r.readBy === 'ai' ? 'the AI' : 'the built-in reader'}. A simulation, not a guarantee.</p>
        </>
      )}
    </article>
  );
}
