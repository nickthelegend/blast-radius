import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { useEffect, useRef, useState } from 'react';

import type { GraphNode } from '../lib/api.js';

interface SimNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink {
  source: number | SimNode;
  target: number | SimNode;
  type: string;
}

const COLORS: Record<GraphNode['label'], string> = {
  Version: '#4da3ff',
  LockfileSnapshot: '#8b97b0',
  Repo: '#4ec9a5',
};

/**
 * Force-directed view of a blast radius, drawn on canvas.
 *
 * Canvas rather than SVG because a radius can run to hundreds of nodes and
 * per-node DOM elements make panning and the attack-clock animation stutter.
 * Exposure is drawn as it actually spreads: the compromised version sits at the
 * centre and rings move outward by dependency depth.
 */
export function ForceGraph({
  nodes,
  links,
  sourceId,
  highlight,
  onSelect,
}: {
  nodes: GraphNode[];
  links: Array<{ source: number; target: number; type: string }>;
  sourceId: number;
  highlight?: Set<number>;
  onSelect?: (node: GraphNode) => void;
}): JSX.Element {
  // Honour the OS-level preference rather than animating regardless.
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  // Bumped by the ResizeObserver to re-run the layout effect once the container
  // actually has a size.
  const [tick, setTick] = useState(0);
  /** Hovered node id, in a ref so the draw loop reads it without re-running
   *  the whole layout effect on every mouse move. */
  const hoverRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement!;
    // The effect can run before the flex/grid parent has been laid out, at
    // which point clientWidth is 0 and the canvas renders nothing. Bail out and
    // let the ResizeObserver below re-run this once the box has real size.
    if (parent.clientWidth === 0 || parent.clientHeight === 0) {
      const observer = new ResizeObserver(() => {
        if (parent.clientWidth > 0) {
          observer.disconnect();
          setTick((value) => value + 1);
        }
      });
      observer.observe(parent);
      return () => observer.disconnect();
    }

    const width = parent.clientWidth;
    const height = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Ancestry index: for any node, the set on its shortest path back to the
    // compromised root. Hovering a node lights that chain and dims everything
    // else, which is how you actually read a 300-node graph.
    const parentOf = new Map<number, number>();
    {
      const adjacency = new Map<number, number[]>();
      for (const link of links) {
        const list = adjacency.get(link.source) ?? [];
        list.push(link.target);
        adjacency.set(link.source, list);
        const back = adjacency.get(link.target) ?? [];
        back.push(link.source);
        adjacency.set(link.target, back);
      }
      const queue = [sourceId];
      const seen = new Set([sourceId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of adjacency.get(current) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          parentOf.set(next, current);
          queue.push(next);
        }
      }
    }
    const ancestryOf = (id: number): Set<number> => {
      const chain = new Set<number>([id]);
      let cursor = id;
      for (let i = 0; i < 64 && parentOf.has(cursor); i++) {
        cursor = parentOf.get(cursor)!;
        chain.add(cursor);
      }
      return chain;
    };

    const simNodes: SimNode[] = nodes.map((node) => ({ ...node }));
    const byId = new Map(simNodes.map((node) => [node.id, node]));
    const simLinks: SimLink[] = links
      .filter((link) => byId.has(link.source) && byId.has(link.target))
      .map((link) => ({ ...link }));

    // Pin the compromised version at the centre: the whole picture is "what
    // spreads out from here", and letting it drift makes that unreadable.
    const source = byId.get(sourceId);
    if (source) {
      source.fx = width / 2;
      source.fy = height / 2;
    }

    const simulation = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.id)
          .distance((link) => {
            const target = link.target as SimNode;
            return target.label === 'Repo' ? 70 : 46;
          })
          .strength(0.35),
      )
      .force('charge', forceManyBody<SimNode>().strength(-135).distanceMax(420))
      .force('center', forceCenter(width / 2, height / 2).strength(0.05))
      .force('x', forceX<SimNode>(width / 2).strength(0.02))
      .force('y', forceY<SimNode>(height / 2).strength(0.02));

    // Shockwave: a ring that expands from the compromised node once, on load.
    // It reads as the blast propagating outward, and it is the one moment in
    // the UI that earns an animation.
    const shockStart = performance.now();
    const SHOCK_MS = 1500;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      const focus = hoverRef.current;
      const lit = focus !== null ? ancestryOf(focus) : null;

      if (!reduceMotion && source?.x !== undefined) {
        const t = (performance.now() - shockStart) / SHOCK_MS;
        if (t < 1) {
          const eased = 1 - Math.pow(1 - t, 3);
          ctx.beginPath();
          ctx.arc(source.x, source.y!, eased * Math.max(width, height) * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,92,108,${(1 - t) * 0.5})`;
          ctx.lineWidth = 2.5 * (1 - t) + 0.5;
          ctx.stroke();
        }
      }

      ctx.lineWidth = 1;
      for (const link of simLinks) {
        const a = link.source as SimNode;
        const b = link.target as SimNode;
        if (a.x === undefined || b.x === undefined) continue;
        const onChain = lit ? lit.has(a.id) && lit.has(b.id) : false;
        const highlighted = highlight?.has(a.id) && highlight?.has(b.id);
        ctx.strokeStyle = onChain
          ? 'rgba(255,180,84,0.85)'
          : lit
            ? 'rgba(70,81,107,0.12)'
            : highlighted
              ? 'rgba(255,92,108,0.55)'
              : 'rgba(70,81,107,0.35)';
        ctx.lineWidth = onChain ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y!);
        ctx.lineTo(b.x, b.y!);
        ctx.stroke();
      }

      for (const node of simNodes) {
        if (node.x === undefined) continue;
        const isSource = node.id === sourceId;
        const onChain = lit ? lit.has(node.id) : false;
        const dimmed = lit !== null && !onChain;
        const isHighlighted = highlight?.has(node.id);
        const radius = isSource ? 11 : node.label === 'Repo' ? 7 : 4.5;

        ctx.globalAlpha = dimmed ? 0.18 : 1;

        if (isSource || isHighlighted) {
          ctx.beginPath();
          ctx.arc(node.x, node.y!, radius + 6, 0, Math.PI * 2);
          ctx.fillStyle = isSource ? 'rgba(255,92,108,0.22)' : 'rgba(255,92,108,0.12)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y!, onChain && !isSource ? radius + 1.5 : radius, 0, Math.PI * 2);
        ctx.fillStyle = isSource
          ? '#ff5c6c'
          : onChain
            ? '#ffb454'
            : isHighlighted
              ? '#ff8a95'
              : COLORS[node.label];
        ctx.fill();

        if (node.label === 'Repo' || isSource || onChain) {
          ctx.fillStyle = isSource ? '#ffdfe2' : '#9fb0cc';
          ctx.font = `${isSource ? 12 : 11}px ui-monospace, monospace`;
          ctx.fillText(node.name, node.x + radius + 5, node.y! + 3.5);
        }
        ctx.globalAlpha = 1;
      }
    };

    // The shockwave and hover state both need frames the simulation may not
    // produce once it cools, so drive them independently.
    let raf = 0;
    const animate = () => {
      draw();
      if (performance.now() - shockStart < SHOCK_MS + 100 || hoverRef.current !== null) {
        raf = requestAnimationFrame(animate);
      }
    };
    raf = requestAnimationFrame(animate);

    simulation.on('tick', draw);

    const handleMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      let found: SimNode | null = null;
      for (const node of simNodes) {
        if (node.x === undefined) continue;
        const dx = node.x - mx;
        const dy = node.y! - my;
        if (dx * dx + dy * dy < 100) {
          found = node;
          break;
        }
      }
      const changed = hoverRef.current !== (found?.id ?? null);
      hoverRef.current = found?.id ?? null;
      setHovered(found);
      canvas.style.cursor = found ? 'pointer' : 'default';
      if (changed) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(animate);
      }
    };

    const handleClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      for (const node of simNodes) {
        if (node.x === undefined) continue;
        const dx = node.x - mx;
        const dy = node.y! - my;
        if (dx * dx + dy * dy < 100) {
          onSelect?.(node);
          return;
        }
      }
    };

    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('click', handleClick);

    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('click', handleClick);
      cancelAnimationFrame(raf);
      simulation.stop();
    };
  }, [nodes, links, sourceId, highlight, onSelect, tick, reduceMotion]);

  return (
    <div className="graph-wrap">
      <canvas ref={canvasRef} />
      <div className="graph-legend">
        <span>
          <i style={{ background: '#ff5c6c' }} />
          compromised
        </span>
        <span>
          <i style={{ background: COLORS.Version }} />
          package version
        </span>
        <span>
          <i style={{ background: COLORS.LockfileSnapshot }} />
          lockfile
        </span>
        <span>
          <i style={{ background: COLORS.Repo }} />
          repo
        </span>
      </div>
      {hovered && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'rgba(11,14,20,0.92)',
            border: '1px solid #232b3d',
            borderRadius: 8,
            padding: '8px 12px',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            maxWidth: 380,
          }}
        >
          <div style={{ color: '#dbe2f0' }}>{hovered.name}</div>
          <div style={{ color: '#8b97b0' }}>{hovered.label}</div>
          <div style={{ color: '#ffb454', marginTop: 4, fontSize: 11 }}>
            path to the compromised package highlighted
          </div>
        </div>
      )}
    </div>
  );
}
