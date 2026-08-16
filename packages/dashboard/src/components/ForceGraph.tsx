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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  // Bumped by the ResizeObserver to re-run the layout effect once the container
  // actually has a size.
  const [tick, setTick] = useState(0);

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

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      ctx.lineWidth = 1;
      for (const link of simLinks) {
        const a = link.source as SimNode;
        const b = link.target as SimNode;
        if (a.x === undefined || b.x === undefined) continue;
        const lit = highlight?.has(a.id) && highlight?.has(b.id);
        ctx.strokeStyle = lit ? 'rgba(255,92,108,0.55)' : 'rgba(70,81,107,0.35)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y!);
        ctx.lineTo(b.x, b.y!);
        ctx.stroke();
      }

      for (const node of simNodes) {
        if (node.x === undefined) continue;
        const isSource = node.id === sourceId;
        const lit = highlight?.has(node.id);
        const radius = isSource ? 11 : node.label === 'Repo' ? 7 : 4.5;

        if (isSource || lit) {
          ctx.beginPath();
          ctx.arc(node.x, node.y!, radius + 6, 0, Math.PI * 2);
          ctx.fillStyle = isSource ? 'rgba(255,92,108,0.22)' : 'rgba(255,92,108,0.12)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y!, radius, 0, Math.PI * 2);
        ctx.fillStyle = isSource ? '#ff5c6c' : lit ? '#ff8a95' : COLORS[node.label];
        ctx.fill();

        if (node.label === 'Repo' || isSource) {
          ctx.fillStyle = isSource ? '#ffdfe2' : '#9fb0cc';
          ctx.font = `${isSource ? 12 : 11}px ui-monospace, monospace`;
          ctx.fillText(node.name, node.x + radius + 5, node.y! + 3.5);
        }
      }
    };

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
      setHovered(found);
      canvas.style.cursor = found ? 'pointer' : 'default';
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
      simulation.stop();
    };
  }, [nodes, links, sourceId, highlight, onSelect, tick]);

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
        </div>
      )}
    </div>
  );
}
