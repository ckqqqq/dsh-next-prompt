import { performance } from 'node:perf_hooks';
import { Predictor, LIMITS } from '../src/engine.js';

// Synthetic prequential evaluation: predict BEFORE updating with each target.
// Repeated work patterns exercise adaptation, not real-world accuracy claims.
const workflows = [
  ['修复登录失败', '登录失败已经修复', '运行登录回归测试'],
  ['添加分页接口', '分页接口已经实现', '补充接口边界测试'],
  ['更新项目文档', '项目文档已经更新', '检查文档示例是否正确'],
  ['fix checkout bug', 'checkout bug fixed', 'run checkout regression tests'],
];
const p = new Predictor();
let attempts = 0, offered = 0, correct = 0;
for (let round = 0; round < 10; round++) for (const [request, answer, target] of workflows) {
  const context = `${request}\n${answer}`;
  const guess = p.predict(context)[0];
  attempts++; if (guess) { offered++; if (guess.text === target) correct++; }
  p.learn(context, target!);
}
for (let i = p.export().samples.length; i < LIMITS.samples; i++) p.learn(`other context ${i}`, `other follow up ${i}`);
const durations: number[] = [];
for (let i = 0; i < 1000; i++) {
  const start = performance.now(); p.predict('fix checkout bug\ncheckout bug fixed'); durations.push(performance.now() - start);
}
durations.sort((a, b) => a - b);
console.log(JSON.stringify({ dataset: 'synthetic repeated workflows; no user history', attempts, offered, correct,
  coverage: offered / attempts, precisionWhenOffered: offered ? correct / offered : 0,
  capacity: LIMITS.samples, p50Ms: durations[500], p95Ms: durations[950] }, null, 2));
