import { EVAL } from './evalNumbers';

const REPO = 'https://github.com/Nakul532/rush-hour-lab';

export function CaseStudy() {
  const o = EVAL.original;
  const i = EVAL.interacting;
  const b = EVAL.builder;
  return (
    <article className="case">
      <h1>How Rush Hour Lab works, and what we learned building it</h1>

      <h2>The problem</h2>
      <p>Independent cafés lose customers to long morning-rush waits and can't afford a consultant. The owner's question is simple: what should I change, without hiring anyone or spending much, to cut waits? Rush Hour Lab answers it by simulating the rush and testing changes before anyone moves a single chair.</p>

      <h2>Data</h2>
      <ul>
        <li><strong>OBSERVED:</strong> 18 timed orders from one moderate-traffic session at a Bay Area café (9 drink only, 4 food only, 5 drink + food). The only real waits in the project.</li>
        <li><strong>PUBLISHED BENCHMARK:</strong> a coffee-shop queuing study (UTHM, M/M/1, average time in system 3.52 min), used to check the simulator, and City Observatory's order-placement times.</li>
        <li><strong>Reconstructed:</strong> Curio Coffee, from a 2025 class Lean proposal whose recommendations were not implemented. Its figures don't fit together (300 orders in two hours would need about 24 staff at its step times), so we read the step times as elapsed time including waiting and fitted one scale factor to the 8–12 min waits staff reported.</li>
      </ul>

      <h2>Method</h2>
      <ol>
        <li><strong>Simulator.</strong> A discrete-event model of one rush: random arrivals per 15 minutes, cashier → barista and/or kitchen → handoff, staff that can change during the rush. Tested against queueing theory (M/M/1 gives 3.52 min; Little's law holds exactly; the same seed gives identical results).</li>
        <li><strong>Calibration.</strong> Task times fitted to the 18 observed orders. Drink-only and food-only waits match; drink + food waits come out about 5.6 min short of the observed 17 min (three of those five orders may be one group order). Adding grab-and-go items raised leave-one-out coverage from 12 to 15 of 18.</li>
        <li><strong>Acceptance rule (code, not the AI's opinion).</strong> A change is recommended only if the bad-case (90th percentile) wait improves by at least 10%, the paired 95% confidence interval excludes zero, it still helps with every task 30% faster and 30% slower, no order type gets more than 10% worse, every order gets served, and time in the café (including the order line) gets no more than 10% worse. Every plan from every path first passes one shared validator (no station left without staff during the rush). The final pick is re-checked on a fresh simulation before it is shown.</li>
        <li><strong>Search.</strong> Code tests every combination of options (brute force) when that fits in about 20 seconds, and a step-by-step greedy search otherwise. An AI analyst (gpt-oss-120b) proposes and tests its own ideas in the same option space. Whichever passing plan is best is recommended, and the page says which method found it.</li>
      </ol>

      <h2>Evaluation</h2>
      <p>20 test cafés (18 synthetic), each with a small enough option space that brute force finds the truly best plan. Scenarios and scoring were committed before any agent ran.</p>
      <table>
        <thead><tr><th></th><th>AI agent</th><th>Greedy search</th><th>Brute force</th></tr></thead>
        <tbody>
          <tr><td>Best plan found, 15 original scenarios</td><td>{o.agent.best} of 15 (re-run: {o.agentRerun.best})</td><td>{o.greedy.best} of 15</td><td>15 of 15</td></tr>
          <tr><td>Best plan found, 5 interacting-changes scenarios</td><td>{i.agent.best} of 5</td><td>{i.greedy.best} of 5</td><td>5 of 5</td></tr>
          <tr><td>Simulations used (original 15)</td><td>{o.agent.sims}</td><td>{o.greedy.sims}</td><td>—</td></tr>
        </tbody>
      </table>
      <p><strong>The AI agent never beat plain search.</strong> It found the best plan in {o.agent.best} of 15 scenarios against greedy's {o.greedy.best}, and fell into the same budget traps greedy did in the interacting scenarios. That is why the product uses code to search and the AI to read descriptions, answer what-if questions and explain results. The AI's ideas are still tested and credited when they win.</p>
      <p><strong>False positives:</strong> {o.falsePositives} of {o.accepted} accepted plans failed a fresh re-check on the original scenarios, but {i.falsePositives} of {i.accepted} did in the interacting ones. All of those were borderline (passing at 10–13%, re-measured just under 10%) and none was a best plan. That is why the final recommendation is always re-checked before it is shown.</p>
      <p><strong>Turning descriptions into cafés:</strong> {b.before.pct}% of stated fields correct at first; {b.heldOut.pct}% on five held-out descriptions after fixing how stated zeros ("no kitchen staff") are read.</p>

      <h2>Three things that went wrong, and what they taught us</h2>
      <h3>1. The metric was gameable: testing caught it before an agent could</h3>
      <p>While testing the acceptance rule we tried "move the cook to the drinks station". It passed every check with an 82% shorter bad-case wait and no cost. It was too good to be true: with nobody in the kitchen, food orders never finished, and the simulator only measured orders that did. The rule was rewarding a café that stops serving food. Fix: the simulator reports unserved orders, plans that leave a station empty are refused, and the rule gained a check that every order gets served. Lesson: an optimizer will find the cheapest way to move the number it is judged by, so report what a metric leaves out.</p>
      <h3>2. Mocked tests passed; the first live call failed</h3>
      <p>All 105 tests passed with a scripted AI. The first live run then sent the same incomplete change ten times. Our tool schema declared only the change's kind, and the model followed the schema exactly. Fix: declare every field, return errors that name what is missing, and stop after three identical failures. The real responses are now a replay test.</p>
      <h3>3. "Wait" starts at the till, so the metric was gameable a second time</h3>
      <p>We measure wait from placing the order to receiving it, matching how the 18 orders were timed. None of the 167 plans accepted in the evaluation made time in the café worse, so at first we only showed both numbers. Then the live app, on the near-capacity Curio café with no new hires, recommended moving a cashier to the kitchen: wait 66% shorter, every check passed, but time in the café rose from 43 to 169 minutes because the order line grew without limit. Fix: the rule now also requires that time in the café gets no more than 10% worse. Re-running all 20 evaluation scenarios with it changed no result. In the same session an empty register (two moves off a two-person till) slipped through a search path that skipped the empty-station check, the same bug as story 1 by a different route. Now one shared validator serves every path, with a test for each.</p>

      <h2>Limitations</h2>
      <ul>
        <li>Calibrated on 18 orders from one session at one café. Staffing, arrival rate and several task times there are assumptions.</li>
        <li>18 of the 20 evaluation cafés are synthetic, and their option spaces are small.</li>
        <li>Confidence intervals cover simulation noise only, not whether the model matches a real café.</li>
        <li>Costs are user-entered; the defaults are assumptions.</li>
        <li>Decision support, not a guarantee.</li>
      </ul>
      <p>Code, data provenance and full evaluation: <a href={REPO}>{REPO.replace('https://', '')}</a> (see calibration/REPORT.md and eval/README.md).</p>
    </article>
  );
}
