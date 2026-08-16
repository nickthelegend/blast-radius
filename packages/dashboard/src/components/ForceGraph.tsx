import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
} from 'd3-force';
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

/* The survey key, matching the tokens in styles.css. Shape carries type as
   well as colour, so the plot is readable in greyscale. */
const INK = '#ece6da';
const INK_2 = '#b5aa99';
const INK_3 = '#6f665a'; // plotted marks only, never a word
const RULE = '#35302a';
const BLAST = '#ff6a45';
const BUFF = '#e3ac57';
const CLEAR = '#9dc46f';

const COLORS: Record<GraphNode['label'], string> = {
  Version: INK_3,
  LockfileSnapshot: '#8a7f6d',
  Repo: CLEAR,
};

/** Node marks: a circle, a square and a diamond are distinguishable without colour. */
function plotMark(
  ctx: CanvasRenderingContext2D,
  label: GraphNode['label'] | 'source',
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  if (label === 'Repo') {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (label === 'LockfileSnapshot' || label === 'source') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

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

    // Dependency depth from ground zero, measured on the graph itself. This is
    // the sheet's distance scale: every node is placed on the ring for its own
    // hop count, so an annulus is a measurement and reading distance off the
    // plot is reading dependency depth. Nothing here is decorative.
    const depthOf = new Map<number, number>();
    {
      const adjacency = new Map<number, number[]>();
      const link = (a: number, b: number) => {
        if (!adjacency.has(a)) adjacency.set(a, []);
        adjacency.get(a)!.push(b);
      };
      for (const edge of simLinks) {
        link(edge.source as number, edge.target as number);
        link(edge.target as number, edge.source as number);
      }
      const queue: number[] = [sourceId];
      depthOf.set(sourceId, 0);
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const next = depthOf.get(current)! + 1;
        for (const neighbour of adjacency.get(current) ?? []) {
          if (depthOf.has(neighbour)) continue;
          depthOf.set(neighbour, next);
          queue.push(neighbour);
        }
      }
    }
    const maxDepth = Math.max(...depthOf.values(), 1);
    // Bands are spaced to fill the plot, with the outermost inside the frame.
    const band = Math.min(width, height) * 0.46 / Math.max(1, maxDepth);
    const ringFor = (id: number): number => (depthOf.get(id) ?? maxDepth) * band;

    const centreX = width / 2;
    const centreY = height / 2;

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
      .force('charge', forceManyBody<SimNode>().strength(-95).distanceMax(360))
      .force('center', forceCenter(centreX, centreY).strength(0.04))
      // The distance scale. Strong enough that the rings are true, weak enough
      // that the link force still spreads each band out around its ring.
      .force(
        'ring',
        forceRadial<SimNode>((node) => ringFor(node.id), centreX, centreY).strength(0.92),
      );


    // The sweep: one expanding annulus that settles at the outermost ring,
    // the way a survey is struck off from ground zero.
    if (source) {
      source.fx = centreX;
      source.fy = centreY;
    }

    const shockStart = performance.now();
    const SHOCK_MS = 1500;

    const ringRadius = (depth: number): number => depth * band;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      const focus = hoverRef.current;
      const lit = focus !== null ? ancestryOf(focus) : null;

      // --- range rings: the survey's annuli, one per dependency hop ---------
      if (source?.x !== undefined) {
        ctx.save();
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 1;
        ctx.font = '10px "Plex Mono", ui-monospace, monospace';
        for (let depth = 1; depth <= Math.min(maxDepth, 6); depth++) {
          const radius = ringRadius(depth);
          if (radius < 24) continue;
          ctx.strokeStyle = '#453e35';
          ctx.beginPath();
          ctx.arc(source.x, source.y!, radius, 0, Math.PI * 2);
          ctx.stroke();
          // The ring's own label, set on the ring where a chart puts it.
          ctx.setLineDash([]);
          ctx.fillStyle = INK_3;
          const count = [...depthOf.values()].filter((value) => value === depth).length;
          const label = `${depth} HOP${depth === 1 ? '' : 'S'} — ${count}`;
          // Set on the ring at the top of the plot, where a chart labels its
          // distance scale and no node is competing for the space.
          const tx = source.x + 6;
          const ty = source.y! - radius;
          const w = ctx.measureText(label).width;
          ctx.fillStyle = '#0d0c0a';
          ctx.fillRect(tx - 4, ty - 7, w + 8, 13);
          ctx.fillStyle = '#968b7b';
          ctx.fillText(label, tx, ty + 3);
          ctx.setLineDash([2, 5]);
        }
        ctx.restore();
      }

      // --- the sweep --------------------------------------------------------
      if (!reduceMotion && source?.x !== undefined) {
        const t = (performance.now() - shockStart) / SHOCK_MS;
        if (t < 1) {
          const eased = 1 - Math.pow(1 - t, 3);
          const settle = ringRadius(maxDepth) || Math.max(width, height) * 0.45;
          ctx.beginPath();
          ctx.arc(source.x, source.y!, eased * settle, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,106,69,${(1 - t) * 0.55})`;
          ctx.lineWidth = 1.5;
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
          ? 'rgba(227,172,87,0.9)'
          : lit
            ? 'rgba(111,102,90,0.12)'
            : highlighted
              ? 'rgba(255,106,69,0.5)'
              : 'rgba(111,102,90,0.32)';
        ctx.lineWidth = onChain ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y!);
        ctx.lineTo(b.x, b.y!);
        ctx.stroke();
      }

      const labels: Array<{
        text: string;
        x: number;
        y: number;
        colour: string;
        size: number;
        priority: number;
        alpha: number;
      }> = [];

      for (const node of simNodes) {
        if (node.x === undefined) continue;
        const isSource = node.id === sourceId;
        const onChain = lit ? lit.has(node.id) : false;
        const dimmed = lit !== null && !onChain;
        const isHighlighted = highlight?.has(node.id);
        const radius = isSource ? 11 : node.label === 'Repo' ? 7 : 4.5;

        ctx.globalAlpha = dimmed ? 0.18 : 1;

        if (isSource || isHighlighted) {
          plotMark(ctx, isSource ? 'source' : node.label, node.x, node.y!, radius + 6);
          ctx.fillStyle = isSource ? 'rgba(255,106,69,0.20)' : 'rgba(255,106,69,0.11)';
          ctx.fill();
        }

        plotMark(
          ctx,
          isSource ? 'source' : node.label,
          node.x,
          node.y!,
          onChain && !isSource ? radius + 1.5 : radius,
        );
        ctx.fillStyle = isSource
          ? BLAST
          : onChain
            ? BUFF
            : isHighlighted
              ? BLAST
              : COLORS[node.label];
        ctx.fill();

        // Ground zero gets a survey crosshair. It is the origin every measurement
        // on this sheet is taken from, and it should read as one.
        if (isSource) {
          ctx.strokeStyle = BLAST;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(node.x - radius - 7, node.y!);
          ctx.lineTo(node.x - radius - 2, node.y!);
          ctx.moveTo(node.x + radius + 2, node.y!);
          ctx.lineTo(node.x + radius + 7, node.y!);
          ctx.moveTo(node.x, node.y! - radius - 7);
          ctx.lineTo(node.x, node.y! - radius - 2);
          ctx.moveTo(node.x, node.y! + radius + 2);
          ctx.lineTo(node.x, node.y! + radius + 7);
          ctx.stroke();
        }

        if (node.label === 'Repo' || isSource || onChain) {
          // Collected, not drawn: labels are laid last so a dense inner band
          // cannot bury the name of an exposed repository under a version.
          labels.push({
            text: node.name,
            x: node.x + radius + 8,
            y: node.y! + 3.5,
            colour: isSource ? INK : isHighlighted ? BLAST : INK_2,
            size: isSource ? 12 : 11,
            priority: isSource ? 0 : isHighlighted ? 1 : node.label === 'Repo' ? 2 : 3,
            alpha: dimmed ? 0.18 : 1,
          });
        }
        ctx.globalAlpha = 1;
      }

      // --- annotation pass ---------------------------------------------------
      // A survey annotates what it can without overprinting. Ground zero first,
      // then exposed repositories, then everything else; a label that would
      // collide with one already set is dropped rather than stacked on top.
      const placed: Array<[number, number, number, number]> = [];
      labels.sort((a, b) => a.priority - b.priority);
      for (const label of labels) {
        ctx.font = `${label.size}px "Plex Mono", ui-monospace, monospace`;
        const w = ctx.measureText(label.text).width;
        const box: [number, number, number, number] = [
          label.x - 2,
          label.y - label.size,
          w + 4,
          label.size + 4,
        ];
        const clashes = placed.some(
          ([px, py, pw, ph]) =>
            box[0] < px + pw && box[0] + box[2] > px && box[1] < py + ph && box[1] + box[3] > py,
        );
        if (clashes) continue;
        placed.push(box);
        ctx.globalAlpha = label.alpha;
        // Knock the plot out behind the annotation, the way a chart reserves
        // white space for a callout instead of printing over its own line work.
        ctx.fillStyle = '#0d0c0a';
        ctx.globalAlpha = label.alpha * 0.82;
        ctx.fillRect(box[0], box[1] + 2, box[2], box[3] - 2);
        ctx.globalAlpha = label.alpha;
        ctx.fillStyle = label.colour;
        ctx.fillText(label.text, label.x, label.y);
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
          <i style={{ background: BLAST, transform: 'rotate(45deg)' }} />
          ground zero
        </span>
        <span>
          <i style={{ background: COLORS.Version, borderRadius: '50%' }} />
          version
        </span>
        <span>
          <i style={{ background: COLORS.LockfileSnapshot, transform: 'rotate(45deg)' }} />
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
            top: 10,
            right: 10,
            background: '#0d0c0a',
            border: `1px solid ${RULE}`,
            borderRadius: 0,
            padding: '9px 13px',
            fontFamily: '"Plex Mono", ui-monospace, monospace',
            fontSize: 13,
            maxWidth: 380,
          }}
        >
          <div style={{ color: INK }}>{hovered.name}</div>
          <div style={{ color: INK_2 }}>{hovered.label}</div>
          <div style={{ color: BUFF, marginTop: 5 }}>chain to ground zero struck out</div>
        </div>
      )}
    </div>
  );
}
