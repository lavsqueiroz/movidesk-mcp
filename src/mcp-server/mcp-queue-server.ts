#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMovideskClient } from '../services/MovideskClient.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const movideskClient = getMovideskClient();

const server = new Server(
  { name: 'movidesk-queue', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

const N1_JUSTIFICATIVAS = ['Retorno do cliente', 'Retorno NewCon', 'Priorizacao'];

const URGENCY_LABELS: Record<number, string> = {
  1: 'Simples',
  2: 'Moderado',
  3: 'Importante',
  4: 'Grave',
};

function loadPrompt(filename: string): string {
  const p = path.join(__dirname, '../../prompts', filename);
  if (!fs.existsSync(p)) throw new Error(`Prompt nao encontrado: ${filename}`);
  return fs.readFileSync(p, 'utf-8');
}

function loadContext(papel: string): string {
  const map: Record<string, string> = {
    orquestrador: 'ORQUESTRADOR.md', n1: 'Agentes/N1_PAPEL.md', n2: 'Agentes/N2_PAPEL.md',
    n3: 'Agentes/N3_PAPEL.md', admin: 'Agentes/ADMIN_PAPEL.md', gestor: 'Agentes/GESTOR_PAPEL.md',
  };
  const content = loadPrompt(map[papel] || 'ORQUESTRADOR.md');
  if (papel === 'gestor') return content;
  return content + '\n\n---\n\n' + loadPrompt('Webhook/AGENTE_WEBHOOK.md');
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}
function avgOrNull(arr: number[]): number | null {
  if (!arr.length) return null;
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 100) / 100;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_context',
      description: 'Carrega o contexto completo de um papel.',
      inputSchema: { type: 'object', properties: { papel: { type: 'string', enum: ['orquestrador','n1','n2','n3','admin','gestor'] } } },
    },
    {
      name: 'list_n1_tickets',
      description: 'N1: Lista TODOS os tickets da fila N1.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'analyze_ticket_n1',
      description: 'N1: Busca dados completos de um ticket e carrega base de conhecimento N1.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'] },
    },
    {
      name: 'create_note_approved',
      description: 'N1: Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' }, note_content: { type: 'string' } }, required: ['ticket_id', 'note_content'] },
    },
    {
      name: 'admin_list_tickets',
      description: 'ADMIN: Lista tickets do Movidesk com filtro opcional de status.',
      inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number', default: 50 } } },
    },
    {
      name: 'admin_get_ticket',
      description: 'ADMIN: Busca detalhes completos de um ticket pelo ID.',
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'] },
    },
    {
      name: 'export_all_tickets',
      description:
        'RELATORIO/GESTOR: Exporta TODOS os tickets da janela de 90 dias da API do Movidesk (sem filtro de data na query — filtragem por periodo feita em memoria apos busca). ' +
        'Sempre inclui actions (necessario para metricas). ' +
        'Filtro de status opcional (aplicado na query). ' +
        'Filtro de data opcional (aplicado em memoria sobre createdDate). ' +
        'Retorna: total, periodo, resumo com dados pre-calculados, e tickets[].',
      inputSchema: {
        type: 'object',
        properties: {
          status:                { type: 'string',  description: 'Filtrar por status na API. Omitir para todos.' },
          date_from:             { type: 'string',  description: 'YYYY-MM-DD. Filtra em memoria por createdDate >= data. Padrao: 60 dias atras.' },
          date_to:               { type: 'string',  description: 'YYYY-MM-DD. Filtra em memoria por createdDate <= data. Padrao: hoje.' },
          include_custom_fields: { type: 'boolean', default: false },
          include_clients:       { type: 'boolean', default: true },
        },
      },
    },
    {
      name: 'get_tickets_status_histories',
      description: 'GESTOR (OPCIONAL): Busca statusHistories individualmente por ticket (1 req/ticket). Use apenas se total <= 150.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_ids:  { type: 'array', items: { type: 'string' } },
          concurrency: { type: 'number', default: 5 },
        },
        required: ['ticket_ids'],
      },
    },
    {
      name: 'generate_metrics',
      description:
        'GESTOR: Calcula metricas de desempenho a partir de um array de tickets. ' +
        'Aceita tickets de qualquer origem (export_all_tickets ou admin_list_tickets com dados completos). ' +
        'Se receber o objeto raiz do export, extrai tickets[] automaticamente.',
      inputSchema: {
        type: 'object',
        properties: {
          tickets:              { description: 'Array de tickets ou objeto raiz do export (auto-extraido).' },
          status_histories_map: { type: 'object', description: 'Opcional. Do get_tickets_status_histories.' },
        },
        required: ['tickets'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {

      case 'get_context': {
        return { content: [{ type: 'text', text: loadContext((args as any).papel || 'orquestrador') }] };
      }

      case 'list_n1_tickets': {
        const [novos, emAt, aguard] = await Promise.all([
          movideskClient.listTicketsByStatus('Novo'),
          movideskClient.listTicketsByStatus('Em atendimento'),
          movideskClient.listTicketsAguardandoN1(N1_JUSTIFICATIVAS),
        ]);
        return { content: [{ type: 'text', text: JSON.stringify({
          total: novos.length + emAt.length + aguard.length,
          resumo: { novo: novos.length, em_atendimento: emAt.length, aguardando_n1: aguard.length },
          tickets: [
            ...novos.map(t  => ({ ...t, grupo: 'Novo' })),
            ...emAt.map(t   => ({ ...t, grupo: 'Em atendimento' })),
            ...aguard.map(t => ({ ...t, grupo: 'Aguardando' })),
          ],
        }, null, 2) }] };
      }

      case 'analyze_ticket_n1': {
        const ticketId = (args as any).ticket_id;
        if (!ticketId) throw new Error('ticket_id e obrigatorio');
        const ticket = await movideskClient.getTicket(ticketId);
        if (!ticket) throw new Error(`Ticket ${ticketId} nao encontrado`);
        const n1Papel   = loadPrompt('Agentes/N1_PAPEL.md');
        const descricao = (ticket as any).actions?.length ? (ticket as any).actions[0].description : 'Sem descricao';
        return { content: [{ type: 'text', text:
          `# TICKET ${ticketId}\n\n` +
          `- ID: ${ticket.id}\n- Assunto: ${ticket.subject}\n- Status: ${ticket.status}\n` +
          `- Justification: ${ticket.justification || 'N/A'}\n- Criado: ${ticket.createdDate}\n\n` +
          `## Descricao\n\n${descricao}\n\n---\n\n## Base N1\n\n${n1Papel}`
        }] };
      }

      case 'create_note_approved': {
        const { ticket_id, note_content } = args as any;
        if (!ticket_id || !note_content) throw new Error('ticket_id e note_content sao obrigatorios');
        const ok = await movideskClient.createInternalNote({ ticketId: ticket_id, description: note_content, isInternal: true });
        if (!ok) throw new Error('Falha ao criar nota');
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'success',
          message: `Nota criada no ticket ${ticket_id}`,
          ticket_url: `https://newm.movidesk.com/Ticket/Edit/${ticket_id}`,
        }, null, 2) }] };
      }

      case 'admin_list_tickets': {
        const status = (args as any).status || null;
        const limit  = Math.min((args as any).limit || 50, 200);
        const tickets = await movideskClient.adminListTickets(status, limit);
        return { content: [{ type: 'text', text: JSON.stringify({
          total: tickets.length,
          filtro_status: status || 'todos',
          tickets: tickets.map(t => ({
            id: t.id, subject: t.subject, status: t.status,
            justification: t.justification || null, createdDate: t.createdDate,
          })),
        }, null, 2) }] };
      }

      case 'admin_get_ticket': {
        const ticketId = (args as any).ticket_id;
        if (!ticketId) throw new Error('ticket_id e obrigatorio');
        const ticket = await movideskClient.getTicket(ticketId);
        if (!ticket) throw new Error(`Ticket ${ticketId} nao encontrado`);
        return { content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }] };
      }

      case 'export_all_tickets': {
        const a = args as any;
        const dateFrom = a.date_from || daysAgo(60);
        const dateTo   = a.date_to   || todayStr();

        // Busca todos os tickets sem filtro de data na query (evita problemas de encoding do $filter).
        // O filtro de status e aplicado na query (ja funciona via admin_list_tickets).
        // O filtro de data e aplicado em memoria sobre createdDate apos a busca.
        const result = await movideskClient.exportAllTickets({
          status:              a.status || null,
          dateFrom:            null,  // sem filtro de data na query
          dateTo:              null,  // sem filtro de data na query
          includeActions:      true,
          includeCustomFields: a.include_custom_fields === true,
          includeClients:      a.include_clients !== false,
        });

        // Aplica filtro de periodo em memoria por createdDate
        const dateFromTs = new Date(dateFrom + 'T00:00:00.000Z').getTime();
        const dateToTs   = new Date(dateTo   + 'T23:59:59.999Z').getTime();
        const ticketsFiltrados = result.tickets.filter(t => {
          if (!t.createdDate) return false;
          const ts = new Date(t.createdDate).getTime();
          return ts >= dateFromTs && ts <= dateToTs;
        });

        console.error(`EXPORT: Total bruto=${result.tickets.length} | Apos filtro ${dateFrom}->${dateTo}: ${ticketsFiltrados.length}`);

        // Metricas de resumo pre-calculadas sobre os tickets ja filtrados
        const statusCount:   Record<string, number> = {};
        const categoryCount: Record<string, number> = {};
        const urgencyCount:  Record<string, number> = {};
        const volumeMensal:  Record<string, number> = {};
        let resolvedInFirstCallCount = 0;
        let withSlaBreached = 0;
        const openStatuses = ['Novo', 'Em atendimento', 'Aguardando', 'Recorrente'];

        const lifeHours:    number[] = [];
        const stoppedHours: number[] = [];
        const abFechHoras:  number[] = [];
        const distFechamento = { ate_24h: 0, d1_3: 0, d3_7: 0, mais_7d: 0 };

        for (const t of ticketsFiltrados) {
          const s = t.status || 'Desconhecido';
          statusCount[s] = (statusCount[s] || 0) + 1;

          const c = t.category || 'Sem categoria';
          categoryCount[c] = (categoryCount[c] || 0) + 1;

          const uLabel = (t.urgency != null && URGENCY_LABELS[t.urgency])
            ? URGENCY_LABELS[t.urgency]
            : (t.urgency != null ? String(t.urgency) : 'N/D');
          urgencyCount[uLabel] = (urgencyCount[uLabel] || 0) + 1;

          if (t.resolvedInFirstCall) resolvedInFirstCallCount++;

          if (t.slaSolutionDate && new Date(t.slaSolutionDate) < new Date() && openStatuses.includes(t.status || ''))
            withSlaBreached++;

          if (t.createdDate) {
            const d = new Date(t.createdDate);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            volumeMensal[key] = (volumeMensal[key] || 0) + 1;
          }

          if (t.lifeTimeWorkingTime != null)   lifeHours.push(t.lifeTimeWorkingTime / 60);
          if (t.stoppedTimeWorkingTime != null) stoppedHours.push(t.stoppedTimeWorkingTime / 60);

          if (t.lifeTimeWorkingTime != null) {
            const h = t.lifeTimeWorkingTime / 60;
            if      (h <= 24)  distFechamento.ate_24h++;
            else if (h <= 72)  distFechamento.d1_3++;
            else if (h <= 168) distFechamento.d3_7++;
            else               distFechamento.mais_7d++;
          }

          const fim = t.closedIn || t.resolvedIn;
          if (t.createdDate && fim) {
            const h = (new Date(fim).getTime() - new Date(t.createdDate).getTime()) / 3_600_000;
            if (h > 0) abFechHoras.push(h);
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({
          exportedAt:         result.exportedAt,
          total:              ticketsFiltrados.length,
          total_bruto_90d:    result.tickets.length,
          pages_fetched:      result.pages,
          periodo:            { dateFrom, dateTo },
          filtro_aplicado_em: 'memoria (createdDate)',

          resumo: {
            total_tickets:                         ticketsFiltrados.length,
            por_status:                            statusCount,
            por_categoria:                         categoryCount,
            por_urgencia:                          urgencyCount,
            resolvidos_no_primeiro_contato:        resolvedInFirstCallCount,
            tickets_com_sla_vencido:               withSlaBreached,
            volume_mensal:                         volumeMensal,
            tempo_medio_vida_horas:                avgOrNull(lifeHours),
            tempo_medio_parado_horas:              avgOrNull(stoppedHours),
            tempo_medio_abertura_fechamento_horas: avgOrNull(abFechHoras),
            distribuicao_tempo_fechamento:         distFechamento,
            tickets_com_data_fechamento:           ticketsFiltrados.filter(t => t.closedIn || t.resolvedIn).length,
          },

          tickets: ticketsFiltrados,
        }, null, 2) }] };
      }

      case 'get_tickets_status_histories': {
        const { ticket_ids, concurrency } = args as any;
        if (!Array.isArray(ticket_ids) || ticket_ids.length === 0)
          throw new Error('ticket_ids deve ser um array nao vazio');
        if (ticket_ids.length > 200)
          console.error(`STATUS_HIST: AVISO — ${ticket_ids.length} tickets. Pode demorar minutos.`);
        const map = await movideskClient.fetchStatusHistoriesBatch(ticket_ids, Math.min(concurrency || 5, 8));
        return { content: [{ type: 'text', text: JSON.stringify({
          total_processados:    Object.keys(map).length,
          status_histories_map: map,
        }, null, 2) }] };
      }

      case 'generate_metrics': {
        const { tickets, status_histories_map } = args as any;

        // Auto-detect: aceita array direto OU objeto raiz do export
        let ticketArray = tickets;
        if (!Array.isArray(tickets)) {
          if (tickets?.tickets && Array.isArray(tickets.tickets)) {
            ticketArray = tickets.tickets;
            console.error('METRICS: objeto raiz recebido — extraindo tickets[] automaticamente.');
          } else {
            throw new Error('Passe um array de tickets, ou o objeto raiz completo do export.');
          }
        }
        if (ticketArray.length === 0)
          throw new Error('Array de tickets vazio.');

        const metricas = movideskClient.generateMetrics(ticketArray, status_histories_map || undefined);
        return { content: [{ type: 'text', text: JSON.stringify(metricas, null, 2) }] };
      }

      default:
        throw new Error(`Tool desconhecida: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: error.message }, null, 2) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Movidesk MCP v3.0.0 - Pronto!');
}
main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
