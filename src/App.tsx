import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  Handle,
  Position,
  type Node,
  type NodeProps,
  type NodeTypes,
  type Edge,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';

import '@xyflow/react/dist/style.css';
import './index.css';

type Status = 'READY' | 'RUNNING' | 'DONE' | 'BLOCKED' | 'FAILED' | 'UNKNOWN';

type RuntimeNode = {
  id: string;
  status: Status;
  worker: string | null;
  startedAt: string | null;
  result: string | null;
  commit: string | null;
  proof: string | null;
};

type RuntimeState = {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  nodes: RuntimeNode[];
};

type Execution = {
  id?: string;
  runId?: string;
  worktree?: string;
  pid?: number;
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  commit?: string;
  error?: string;
};

type GraphNode = {
  id: string;
  title: string;
  status?: Status;
  repo: string;
  outcome: string;
  detail: string;
  context: string[];
  proof: string;
  ownerGate?: string;
  receipt?: string;
  execution?: Execution;
  runtime?: RuntimeNode;
};

type GraphSource = {
  title: string;
  source: string;
  updatedAt?: string;
  revision?: number;
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string }[];
};

type FlowNodeData = Omit<GraphNode, 'status'> & { status: Status; label: string };
type FlowNode = Node<FlowNodeData, 'graphNode'>;

const NODE_WIDTH = 250;
const NODE_HEIGHT = 130;
const statuses: Status[] = ['READY', 'RUNNING', 'DONE', 'BLOCKED', 'FAILED', 'UNKNOWN'];
const statusLabels: Record<Status, string> = {
  READY: 'ГОТОВ', RUNNING: 'В РАБОТЕ', DONE: 'ВЫПОЛНЕН', BLOCKED: 'ЗАБЛОКИРОВАН', FAILED: 'ОШИБКА', UNKNOWN: 'НЕИЗВЕСТНО',
};

function GraphCard({ data, selected }: NodeProps<FlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className={`graph-card status-${data.status.toLowerCase()} ${selected ? 'is-selected' : ''}`}>
        <div className="graph-card-top">
          <span className="node-id">{data.id}</span>
          <span className="status-pill"><i />{statusLabels[data.status]}</span>
        </div>
        <strong>{data.title}</strong>
        <span className="node-repo">{data.repo}</span>
        <span className="node-outcome">{data.outcome}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

const nodeTypes: NodeTypes = { graphNode: GraphCard };

function layoutGraph(source: GraphSource, vertical = false): { nodes: FlowNode[]; edges: Edge[] } {
  const positions = new Map<string, { x: number; y: number }>();
  if (vertical) {
    source.nodes.forEach((node, index) => positions.set(node.id, { x: 0, y: index * (NODE_HEIGHT + 30) }));
  } else {
    const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    graph.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 90, marginx: 32, marginy: 32 });
    source.nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
    source.edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
    dagre.layout(graph);
    source.nodes.forEach((node) => {
      const point = graph.node(node.id);
      positions.set(node.id, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 });
    });
  }

  const nodes: FlowNode[] = source.nodes.map((node) => {
    return {
      id: node.id,
      type: 'graphNode',
      position: positions.get(node.id)!,
      data: { ...node, status: node.status ?? 'BLOCKED', label: node.title },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      selectable: true,
    };
  });

  const edges: Edge[] = source.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    animated: source.nodes.find((node) => node.id === edge.source)?.status === 'RUNNING'
      || source.nodes.find((node) => node.id === edge.target)?.status === 'RUNNING',
    style: { stroke: '#64748b', strokeWidth: 1.8 },
  }));
  return { nodes, edges };
}

function App() {
  const [source, setSource] = useState<GraphSource | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const update = () => setIsMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const refresh = useCallback(async (showIndicator = true) => {
    if (showIndicator) setLoading(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const customSource = params.get('source');
      const graphUrl = customSource
        ? new URL(customSource, window.location.href)
        : new URL(`${import.meta.env.BASE_URL}graph.json`, window.location.href);
      const runtimeUrl = new URL(`${import.meta.env.BASE_URL}runtime-state.json`, window.location.href);
      graphUrl.searchParams.set('t', String(Date.now()));
      runtimeUrl.searchParams.set('t', String(Date.now()));
      const [response, runtimeResponse] = await Promise.all([
        fetch(graphUrl, { cache: 'no-store' }),
        customSource ? Promise.resolve(null) : fetch(runtimeUrl, { cache: 'no-store' }),
      ]);
      if (!response.ok) throw new Error(`Не удалось загрузить graph.json (${response.status}).`);
      const next = (await response.json()) as GraphSource;
      if (!Array.isArray(next.nodes) || !Array.isArray(next.edges)) {
        throw new Error('В graph.json должны быть массивы nodes и edges.');
      }
      const ids = new Set(next.nodes.map((node) => node.id));
      let liveGraph = next;
      if (runtimeResponse) {
        if (!runtimeResponse.ok) throw new Error(`Не удалось загрузить runtime-state.json (${runtimeResponse.status}).`);
        const runtime = (await runtimeResponse.json()) as RuntimeState;
        if (runtime.schemaVersion !== 1 || !Array.isArray(runtime.nodes) || !Number.isInteger(runtime.revision)) {
          throw new Error('Неподдерживаемый формат runtime-state.json.');
        }
        const runtimeById = new Map(runtime.nodes.map((node) => [node.id, node]));
        if (next.nodes.some((node) => (node.status && !statuses.includes(node.status)) || !runtimeById.has(node.id))) {
          throw new Error('Для каждого узла графа нужен поддерживаемый статус в runtime-state.json.');
        }
        if (runtime.nodes.some((node) => !ids.has(node.id) || !statuses.includes(node.status))) {
          throw new Error('runtime-state.json содержит неизвестный узел или статус.');
        }
        liveGraph = {
          ...next,
          updatedAt: runtime.updatedAt,
          revision: runtime.revision,
          nodes: next.nodes.map((node) => {
            const current = runtimeById.get(node.id)!;
            return { ...node, status: current.status, runtime: current };
          }),
        };
      } else {
        liveGraph = {
          ...next,
          nodes: next.nodes.map((node) => ({ ...node, status: node.status ?? 'BLOCKED' })),
        };
      }
      if (next.edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) {
        throw new Error('Каждое ребро должно ссылаться на существующие узлы.');
      }
      setSource(liveGraph);
      setSelectedId((current) => current && ids.has(current) ? current : next.nodes[0]?.id ?? null);
      setError('');
      setLoadedAt(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось обновить состояние графа.');
    } finally {
      if (showIndicator) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(false), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const { nodes, edges } = useMemo(() => source ? layoutGraph(source, isMobile) : { nodes: [], edges: [] }, [source, isMobile]);
  const selectedNode = source?.nodes.find((node) => node.id === selectedId) ?? null;
  const counts = statuses.map((status) => ({
    status,
    count: source?.nodes.filter((node) => node.status === status).length ?? 0,
  }));
  const onNodeClick = useCallback((_: React.MouseEvent, node: FlowNode) => setSelectedId(node.id), []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">c</span><span>craftnode</span><span className="brand-divider" /> <span className="eyebrow">ГРАФ ПРОГРАММЫ</span></div>
        <div className="source-label"><span className="live-dot" />СОСТОЯНИЕ <code>runtime-state.json · r{source?.revision ?? 0}</code></div>
        <button className="refresh-button" onClick={() => void refresh()} disabled={loading}>
          <span className={loading ? 'refresh-icon spinning' : 'refresh-icon'}>↻</span>{loading ? 'Обновляю' : 'Обновить'}
        </button>
      </header>

      <section className="workspace">
        <div className="graph-column">
          <div className="graph-heading">
            <div><div className="eyebrow">ГРАФ ПРОГРАММЫ <span className="heading-separator">/</span> POST FOR ME V0</div><h1>{source?.title ?? 'Загрузка графа…'}</h1></div>
            <div className="updated-label">{loadedAt ? `Обновлено ${loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Подключение к источнику'}</div>
          </div>

          <div className="status-legend">
            {counts.map(({ status, count }) => <span key={status} className={`legend-item status-text-${status.toLowerCase()}`}><i />{statusLabels[status]}<b>{count}</b></span>)}
            <span className="legend-divider" />
            <span className="graph-count">{source?.nodes.length ?? 0} УЗЛОВ <span>·</span> {source?.edges.length ?? 0} СВЯЗЕЙ</span>
          </div>

          <div className="canvas-wrap">
            {error && <div className="error-banner">Source error: {error}</div>}
            {source && <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              edgesFocusable={false}
              fitView={!isMobile}
              fitViewOptions={{ padding: 0.16 }}
              defaultViewport={isMobile ? { x: 20, y: 14, zoom: 0.74 } : undefined}
              minZoom={0.35}
              maxZoom={1.4}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#273449" gap={24} size={1} />
              {!isMobile && <MiniMap pannable zoomable nodeColor={(node) => {
                  const status = (node.data as FlowNodeData).status;
                  return ({ READY: '#5284f7', RUNNING: '#e8ad43', DONE: '#39b982', BLOCKED: '#9a83df', FAILED: '#e36b72', UNKNOWN: '#9aa5b5' })[status];
                }} />}
              <Controls showInteractive={false} />
            </ReactFlow>}
            {!source && !error && <div className="empty-state">Загружается источник графа…</div>}
          </div>
          <div className="canvas-foot"><span>ТОЛЬКО ЧТЕНИЕ</span><span>Автообновление · каждые 2 секунды</span></div>
        </div>

        <aside className="detail-panel">
          <div className="panel-heading"><div><div className="eyebrow">СВЕДЕНИЯ ОБ УЗЛЕ</div><h2>Карточка узла</h2></div><span className="panel-icon">⌘</span></div>
          {selectedNode ? <div className="detail-content" key={selectedNode.id}>
            <div className="detail-id">{selectedNode.id}</div>
            <h3>{selectedNode.title}</h3>
            <div className={`detail-status status-text-${(selectedNode.status ?? 'BLOCKED').toLowerCase()}`}><i />{statusLabels[selectedNode.status ?? 'BLOCKED']}</div>
            {selectedNode.runtime && <div className="detail-section"><span className="field-label">ТЕКУЩИЙ ЗАПУСК</span>
              {selectedNode.runtime.worker && <code>Исполнитель: {selectedNode.runtime.worker}</code>}
              {selectedNode.runtime.startedAt && <code>Начат: {new Date(selectedNode.runtime.startedAt).toLocaleString()}</code>}
              {selectedNode.runtime.result && <p><b>Результат:</b> {selectedNode.runtime.result}</p>}
              {selectedNode.runtime.commit && <code>Коммит: {selectedNode.runtime.commit}</code>}
              {selectedNode.runtime.proof && <p><b>Проверка:</b> {selectedNode.runtime.proof}</p>}
            </div>}
            {selectedNode.execution && <div className="detail-section"><span className="field-label">ДАННЫЕ ИСПОЛНЕНИЯ</span>
              <code>{selectedNode.execution.id ?? 'Исполнение зафиксировано'}</code>
              {selectedNode.execution.pid && <code>PID {selectedNode.execution.pid}</code>}
              {selectedNode.execution.sessionId && <code>Сеанс Codex: {selectedNode.execution.sessionId}</code>}
              {selectedNode.execution.worktree && <code>{selectedNode.execution.worktree}</code>}
              {selectedNode.execution.commit && <code>Коммит {selectedNode.execution.commit.slice(0, 12)}</code>}
              {selectedNode.execution.error && <p>{selectedNode.execution.error}</p>}
            </div>}
            <div className="detail-section"><span className="field-label">РЕПОЗИТОРИЙ</span><code>{selectedNode.repo}</code></div>
            <div className="detail-section"><span className="field-label">ОЖИДАЕМЫЙ РЕЗУЛЬТАТ</span><p>{selectedNode.outcome}</p></div>
            <div className="detail-section"><span className="field-label">ОПИСАНИЕ</span><p>{selectedNode.detail}</p></div>
            <div className="detail-section"><span className="field-label">ЗАВИСИТ ОТ</span>
              {source?.edges.filter((edge) => edge.target === selectedNode.id).length ? <div className="tag-list">{source.edges.filter((edge) => edge.target === selectedNode.id).map((edge) => <button className="dependency-tag" key={edge.id} onClick={() => setSelectedId(edge.source)}>{edge.source}<span>↗</span></button>)}</div> : <span className="muted-value">Нет зависимостей · начальный фронт</span>}
            </div>
            <div className="detail-section"><span className="field-label">КАК ПРОВЕРИТЬ</span><p>{selectedNode.proof}</p></div>
            <div className="detail-section"><span className="field-label">КОНТЕКСТ</span><ul>{selectedNode.context.map((item) => <li key={item}>{item}</li>)}</ul></div>
            {selectedNode.ownerGate && <div className="gate-note"><span>ПОДТВЕРЖДЕНИЕ ВЛАДЕЛЬЦА</span><p>{selectedNode.ownerGate}</p></div>}
          </div> : <div className="empty-details">Выберите узел, чтобы увидеть проверку и зависимости.</div>}
          <div className="panel-footer"><span className="live-dot" />{loadedAt ? `СОСТОЯНИЕ ОБНОВЛЕНО ${loadedAt.toLocaleTimeString()}` : 'ОЖИДАНИЕ ИСТОЧНИКА'}</div>
        </aside>
      </section>
    </main>
  );
}

export default App;
