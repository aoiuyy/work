import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = [
  readFileSync(new URL('../ui/features/shell/window-geometry.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../ui/features/shell/BubbleHUD.js', import.meta.url), 'utf8'),
].join('\n');
test('bubble drag captures pointer, suppresses clicks and velocity-snaps inside margins', () => {
  const callbacks = new Map(); let sequence = 0; const states = []; let capture = false;
  const context = vm.createContext({
    useState: initial => { const i = states.length; states.push(typeof initial === 'function' ? initial() : initial); return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
    useRef: current => ({ current }), useEffect: () => {},
    window: { innerWidth: 1000, innerHeight: 700, requestAnimationFrame: fn => { callbacks.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => callbacks.delete(id) },
  });
  vm.runInContext(source + ';globalThis.motion = useBubbleMotion(); globalThis.surface = workSurface; globalThis.snap = snapBubblePoint;', context);
  const target = { setPointerCapture() { capture = true; }, hasPointerCapture() { return capture; }, releasePointerCapture() { capture = false; } };
  const event = (x,y,t) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp: t, currentTarget: target });
  context.motion.down(event(950,600,0));
  assert.equal(capture, true);
  context.motion.move(event(100,500,100));
  assert.equal(callbacks.size, 1);
  context.motion.up(event(100,500,101));
  assert.equal(capture, false);
  assert.equal(callbacks.size, 0);
  assert.equal(states[0].x, 12);
  assert.ok(states[0].y >= 12 && states[0].y <= 640);
  context.motion.click(); assert.equal(context.surface.open, false);
  context.motion.click(); assert.equal(context.surface.open, true);
  assert.equal(context.snap({x:300,y:200},{x:4,y:0},1000,700).x,945);
});

test('bubble radial menu defines 4 non-overlapping edge-aware items', () => {
  assert.match(source, /key:\s*'chats'/);
  assert.match(source, /key:\s*'repo'/);
  assert.match(source, /key:\s*'music'/);
  assert.match(source, /key:\s*'intel'/);
  const ctx = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.compute = computeRadialOffsets;`, ctx);
  for (const [x, y] of [[1310, 696], [12, 696], [1310, 44], [12, 44], [1310, 360]]) {
    const items = ctx.compute({ x, y }, { width: 1365, height: 767 });
    assert.equal(items.length, 4);
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      const left = x + 10 + a.dx;
      const top = y + 10 + a.dy;
      assert.ok(left >= 8 && left <= 1365 - 32, `left ${left} within viewport`);
      assert.ok(top >= 40 && top <= 767 - 32, `top ${top} within viewport`);
      const dist = Math.hypot(a.dx, a.dy);
      assert.ok(dist >= 38 && dist <= 54, `Radial distance ${dist} clears 43px bubble cleanly`);
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        const gap = Math.hypot(a.dx - b.dx, a.dy - b.dy);
        assert.ok(gap >= 25, `Radial separation ${gap} must avoid 24px button overlap`);
      }
    }
  }
});
