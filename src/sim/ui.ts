import { dist } from '../core/math';
import { displayPosition, type GhostLabel, type SimScene } from './scene';
import { TARGET_CENTER_Y, type Sim, type SimParams } from './sim';

interface SliderSpec {
  key: keyof SimParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint?: string;
}

interface ToggleSpec {
  key: keyof SimParams;
  label: string;
  hint?: string;
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

const NETWORK_TOGGLES: ToggleSpec[] = [
  { key: 'share', label: 'Share vision (radios on)', hint: 'Off: every agent only knows what it sees itself.' },
  { key: 'relay', label: 'Mesh relay (multi-hop)', hint: 'Off: only direct neighbours hear each other.' },
];

const NETWORK_SLIDERS: SliderSpec[] = [
  { key: 'rangeM', label: 'Radio range', min: 3, max: 30, step: 0.5, unit: ' m' },
  { key: 'lossPct', label: 'Packet loss', min: 0, max: 90, step: 1, unit: ' %' },
  { key: 'latencyMs', label: 'Hop latency', min: 5, max: 400, step: 5, unit: ' ms' },
];

const POSE_SLIDERS: SliderSpec[] = [
  { key: 'sensorNoiseM', label: 'Sensor noise at 1 m', min: 0, max: 0.5, step: 0.01, unit: ' m' },
  { key: 'yawErrDeg', label: 'Initial heading error', min: 0, max: 10, step: 0.5, unit: ' °', hint: 'Applies on Reset. Each agent starts misaligned.' },
  { key: 'driftPct', label: 'Drift per distance walked', min: 0, max: 5, step: 0.1, unit: ' %' },
];

const POSE_TOGGLES: ToggleSpec[] = [
  { key: 'reanchor', label: 'Re-anchor on markers', hint: 'Walk over a printed marker (yellow rings) to snap your pose back.' },
  { key: 'freezeNpcs', label: 'Freeze everyone but me' },
];

export class Ui {
  private readonly labelPool: HTMLDivElement[] = [];
  private readonly hud = document.getElementById('hud')!;
  private readonly labelsRoot = document.getElementById('labels')!;
  private readonly metrics = document.createElement('div');
  private readonly agentRows: { pick: HTMLButtonElement; life: HTMLButtonElement }[] = [];
  private readonly bound: (() => void)[] = [];
  private metricsAcc = 1;

  constructor(
    private readonly sim: Sim,
    private readonly scene: SimScene,
    private readonly panel: HTMLElement,
  ) {
    this.buildPanel();
  }

  // ---- panel --------------------------------------------------------------------------------

  private buildPanel(): void {
    const p = this.panel;
    p.innerHTML = '';
    const head = document.createElement('h1');
    head.innerHTML = '<span>CROSSCUE · SANDTABLE</span>';
    const collapse = this.button('Hide', () => {
      p.classList.toggle('collapsed');
      collapse.textContent = p.classList.contains('collapsed') ? 'Show' : 'Hide';
    });
    collapse.title = 'Collapse or expand the panel';
    if (window.innerWidth < 760) {
      p.classList.add('collapsed');
      collapse.textContent = 'Show';
    }
    head.append(collapse);
    p.append(head);

    const body = document.createElement('div');
    body.className = 'body';
    p.append(body);
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = 'One agent sees a target; everyone sees it through the walls.';
    body.append(sub);

    body.append(this.h2('Viewer (keys 1-4)'));
    this.sim.agents.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'agent';
      const pick = this.button('', () => {
        this.sim.controlled = i;
      });
      pick.className = 'pick';
      pick.innerHTML = `<span class="dot" style="background:${hex(a.cfg.color)}"></span>${a.cfg.name} <span class="hint">[${i + 1}]</span>`;
      const life = this.button('', () => this.sim.setAlive(i, !a.alive));
      life.title = 'Switch this agent off/on (simulates a lost node)';
      row.append(pick, life);
      body.append(row);
      this.agentRows.push({ pick, life });
    });

    body.append(this.h2('Scenarios'));
    const sc = document.createElement('div');
    sc.className = 'row';
    sc.append(
      this.button('Patrol', () => this.sim.applyScenario('patrol')),
      this.button('Relay chain A-B-C', () => this.sim.applyScenario('chain')),
      this.button('Reset (R)', () => this.sim.reset()),
      this.button('Swap view (Tab)', () => this.swapView()),
    );
    body.append(sc);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Relay chain: Alpha sees the target, Bravo is in the middle, you (Charlie) are out of Alpha\'s radio range and still see it. Switch Bravo off to cut the link.';
    body.append(hint);

    body.append(this.h2('Network'));
    NETWORK_TOGGLES.forEach((t) => body.append(this.toggle(t)));
    NETWORK_SLIDERS.forEach((s) => body.append(this.slider(s)));

    body.append(this.h2('Sensing & pose error'));
    POSE_SLIDERS.forEach((s) => body.append(this.slider(s)));
    POSE_TOGGLES.forEach((t) => body.append(this.toggle(t)));

    body.append(this.h2('Live metrics'));
    body.append(this.metrics);
  }

  private h2(text: string): HTMLElement {
    const h = document.createElement('h2');
    h.textContent = text;
    return h;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', onClick);
    b.addEventListener('mouseup', () => b.blur());
    return b;
  }

  private toggle(spec: ToggleSpec): HTMLElement {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.sim.params[spec.key] as boolean;
    cb.addEventListener('change', () => {
      (this.sim.params[spec.key] as boolean) = cb.checked;
      this.sim.applyNetParams();
    });
    this.bound.push(() => (cb.checked = this.sim.params[spec.key] as boolean));
    label.append(cb, spec.label);
    wrap.append(label);
    if (spec.hint) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = spec.hint;
      wrap.append(h);
    }
    return wrap;
  }

  private slider(spec: SliderSpec): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ctl';
    const label = document.createElement('label');
    label.textContent = spec.label;
    const val = document.createElement('span');
    val.className = 'val';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const show = () => (val.textContent = `${Number(this.sim.params[spec.key]).toFixed(spec.step < 1 ? 2 : 0)}${spec.unit}`);
    input.value = String(this.sim.params[spec.key]);
    show();
    input.addEventListener('input', () => {
      (this.sim.params[spec.key] as number) = Number(input.value);
      this.sim.applyNetParams();
      show();
    });
    this.bound.push(() => {
      input.value = String(this.sim.params[spec.key]);
      show();
    });
    wrap.append(label, val, input);
    if (spec.hint) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.style.gridColumn = '1 / -1';
      h.textContent = spec.hint;
      wrap.append(h);
    }
    return wrap;
  }

  swapView(): void {
    this.scene.mode = this.scene.mode === 'fps' ? 'top' : 'fps';
  }

  // ---- per frame ----------------------------------------------------------------------------

  update(labels: GhostLabel[], dt: number): void {
    this.updateLabels(labels);
    this.updateAgentRows();
    this.updateHud();
    this.metricsAcc += dt;
    if (this.metricsAcc >= 0.25) {
      this.metricsAcc = 0;
      this.bound.forEach((f) => f());
      this.updateMetrics();
    }
  }

  private updateHud(): void {
    const v = this.sim.viewer;
    const view = this.scene.mode === 'fps' ? 'first person' : 'top-down';
    this.hud.innerHTML =
      `Viewing as <b>${v.cfg.name}</b> · ${view} · ` +
      (this.sim.params.paused ? '<b style="color:#facc15">PAUSED</b> · ' : '') +
      `<span style="color:var(--dim)">WASD move · Q/E or drag to turn · Tab swap view · Space pause · R reset</span>`;
  }

  private updateAgentRows(): void {
    this.sim.agents.forEach((a, i) => {
      const r = this.agentRows[i];
      r.pick.classList.toggle('on', i === this.sim.controlled);
      r.life.textContent = a.alive ? 'ON' : 'OFF';
      r.life.classList.toggle('on', a.alive);
    });
  }

  private updateLabels(labels: GhostLabel[]): void {
    while (this.labelPool.length < labels.length) {
      const d = document.createElement('div');
      d.className = 'ghost-label';
      d.innerHTML = '<span class="arrow"></span><span class="txt"></span>';
      this.labelsRoot.append(d);
      this.labelPool.push(d);
    }
    this.labelPool.forEach((d, i) => {
      const l = labels[i];
      if (!l) {
        d.style.display = 'none';
        return;
      }
      d.style.display = 'flex';
      d.style.color = l.color;
      d.style.opacity = String(0.35 + 0.65 * l.opacity);
      d.classList.toggle('clamped', l.clamped);
      d.style.transform = `translate(${l.x}px, ${l.y}px) translate(-50%, ${l.clamped ? '-50%' : '-140%'})`;
      (d.children[0] as HTMLElement).style.transform = `rotate(${-l.angle}rad)`;
      (d.children[1] as HTMLElement).textContent = l.text;
    });
  }

  private updateMetrics(): void {
    const sim = this.sim;
    const v = sim.viewer;
    const now = sim.net.now;
    const tracks = v.model.current(now);

    const rows = sim.targets
      .map((t) => {
        const tr = tracks.find((x) => x.id === t.id);
        const trueDist = Math.hypot(t.pos[0] - v.pos[0], t.pos[2] - v.pos[2]);
        if (!tr) return `<tr><td>${t.name}</td><td>${trueDist.toFixed(1)} m</td><td colspan="4" class="warn">not known</td></tr>`;
        const err = dist(displayPosition(v, tr.pos), [t.pos[0], TARGET_CENTER_Y, t.pos[2]]);
        const cls = err < 0.3 ? 'ok' : err < 0.8 ? 'warn' : 'bad';
        const via = tr.lastHops === 0 ? 'self' : `${tr.lastOrigin} (${tr.lastHops}h)`;
        return (
          `<tr><td>${t.name}</td><td>${trueDist.toFixed(1)} m</td><td class="${cls}">${(err * 100).toFixed(0)} cm</td>` +
          `<td>±${(tr.sigma * 100).toFixed(0)}</td><td>${tr.stale ? '<span class="bad">stale</span> ' : ''}${(tr.ageMs / 1000).toFixed(1)}s</td><td>${via}</td></tr>`
        );
      })
      .join('');

    const agentRows = sim.agents
      .map((a) => {
        const posErr = Math.hypot(a.posErr[0], a.posErr[2]) * 100;
        const yawErr = (Math.abs(a.yawErr) * 180) / Math.PI;
        const ps = a.alive ? '' : ' style="opacity:.4"';
        const pc = posErr < 10 ? 'ok' : posErr < 30 ? 'warn' : 'bad';
        const yc = yawErr < 1 ? 'ok' : yawErr < 3 ? 'warn' : 'bad';
        return (
          `<tr${ps}><td><span class="dot" style="background:${hex(a.cfg.color)}"></span> ${a.cfg.name}</td>` +
          `<td class="${pc}">${posErr.toFixed(0)} cm</td><td class="${yc}">${yawErr.toFixed(1)}°</td>` +
          `<td>${a.received ? a.latencyEma.toFixed(0) + ' ms' : '-'}</td><td>${a.received ? a.hopsEma.toFixed(1) : '-'}</td>` +
          `<td>${[...a.seeing].join(',') || '-'}</td></tr>`
        );
      })
      .join('');

    const s = sim.net.stats;
    this.metrics.innerHTML =
      `<table><tr><th>Target</th><th>Dist</th><th title="where ${v.cfg.name} draws it vs where it really is">Draw error</th><th>σ cm</th><th>Age</th><th>Via</th></tr>${rows}</table>` +
      `<div class="hint">“Draw error” = shared position as ${v.cfg.name} would draw it (observer pose error + viewer pose error + sensor noise) versus the real target.</div>` +
      `<div style="height:8px"></div>` +
      `<table><tr><th>Agent</th><th title="how far its own idea of where it stands is off">Pos err</th><th>Head err</th><th>Latency</th><th>Hops</th><th>Sees</th></tr>${agentRows}</table>` +
      `<div class="hint">Radio: ${s.sent} sent · ${s.delivered} delivered · ${s.lost} lost</div>`;
  }
}
