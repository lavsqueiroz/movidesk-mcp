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
  { name: 'movidesk-queue', version: '2.9.0' },
  { capabilities: { tools: {} } }
);

const N1_JUSTIFICATIVAS = ['Retorno do cliente','Retorno NewCon','Priorizacao'];

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

// Helper: data 60 dias atras em YYYY-MM-DD
function date60DaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 60);
  return d.toISOString().split('T')[0];
}
function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_context',
      description: 'Carrega o contexto completo de um papel. Use sempre que o usuario pedir para se contextualizar ou acionar um papel.',
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
      inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' }, note_content: { type: 'string' } }, required: ['ticket_id','note_content'] },
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
      description: 'RELATORIO/GESTOR: Exporta TODOS os tickets do Movidesk com paginacao automatica. Por padrao usa os ultimos 60 dias. Suporta filtros de status e periodo customizado.',
      inputSchema: {
        type: 'object',
        properties: {
          status:               { type: 'string',  description: 'Filtrar por status. Omitir para todos.' },
          date_from:            { type: 'string',  description: 'Data inicio YYYY-MM-DD. Padrao: 60 dias atras.' },
          date_to:              { type: 'string',  description: 'Data fim YYYY-MM-DD. Padrao: hoje.' },
          include_actions:      { type: 'boolean', default: false },
          include_custom_fields:{ type: 'boolean', default: false },
          include_clients:      { type: 'boolean', default: true  },
        },
      },
    },
    {
      name: 'get_tickets_status_histories',
      description: 'GESTOR: Busca statusHistories individuais de uma lista de ticket IDs. Necessario para calcular transicoes Novo->Em atendimento, Em atendimento->Aguardando, e tempo por justificativa. Retorna map ticketId->statusHistories. Use os IDs retornados pelo export_all_tickets.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_ids: { type: 'array', items: { type: 'string' }, description: 'Lista de IDs de tickets para buscar o statusHistories.' },
          concurrency: { type: 'number', default: 5, description: 'Requisicoes paralelas (max recomendado: 8).' },
        },
        required: ['ticket_ids'],
      },
    },
    {
      name: 'generate_metrics',
      description: 'GESTOR: Calcula todas as metricas de desempenho do suporte. Aceita tickets do export_all_tickets e (opcionalmente) status_histories_map do get_tickets_status_histories para metricas de transicao de status.',
      inputSchema: {
        type: 'object',
        properties: {
          tickets:              { type: 'array',  items: { type: 'object' }, description: 'Array de tickets do export_all_tickets.' },
          status_histories_map: { type: 'object', description: 'Map ticketId->statusHistories retornado por get_tickets_status_histories. Opcional mas necessario para metricas de transicao.' },
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
          tickets: [...novos.map(t=>({...t,grupo:'Novo'})),...emAt.map(t=>({...t,grupo:'Em atendimento'})),...aguard.map(t=>({...t,grupo:'Aguardando'}))],
        }, null, 2) }] };
      }

      case 'analyze_ticket_n1': {
        const ticketId = (args as any).ticket_id;
        if (!ticketId) throw new Error('ticket_id e obrigatorio');
        const ticket = await movideskClient.getTicket(ticketId);
        if (!ticket) throw new Error(`Ticket ${ticketId} nao encontrado`);
        const n1Papel = loadPrompt('Agentes/N1_PAPEL.md');
        const descricao = ticket.actions?.length ? ticket.actions[0].description : 'Sem descricao';
        return { content: [{ type: 'text', text: `# TICKET ${ticketId}\n\n- ID: ${ticket.id}\n- Assunto: ${ticket.subject}\n- Status: ${ticket.status}\n- Justification: ${ticket.justification||'N/A'}\n- Criado: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Base N1\n\n${n1Papel}` }] };
      }

      case 'create_note_approved': {
        const { ticket_id, note_content } = args as any;
        if (!ticket_id || !note_content) throw new Error('ticket_id e note_content sao obrigatorios');
        const ok = await movideskClient.createInternalNote({ ticketId: ticket_id, description: note_content, isInternal: true });
        if (!ok) throw new Error('Falha ao criar nota');
        return { content: [{ type: 'text', text: JSON.stringify({ status:'success', message:`Nota criada no ticket ${ticket_id}`, ticket_url:`https://newm.movidesk.com/Ticket/Edit/${ticket_id}` }, null, 2) }] };
      }

      case 'admin_list_tickets': {
        const status = (args as any).status || null;
        const limit = Math.min((args as any).limit || 50, 200);
        const tickets = await movideskClient.adminListTickets(status, limit);
        return { content: [{ type: 'text', text: JSON.stringify({ total: tickets.length, filtro_status: status||'todos', tickets: tickets.map(t=>({ id:t.id, subject:t.subject, status:t.status, justification:t.justification||null, createdDate:t.createdDate })) }, null, 2) }] };
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
        // Periodo padrao: 60 dias atras ate hoje
        const dateFrom = a.date_from || date60DaysAgo();
        const dateTo   = a.date_to   || todayStr();
        const result = await movideskClient.exportAllTickets({
          status:             a.status      || null,
          dateFrom,
          dateTo,
          includeActions:      a.include_actions       === true,
          includeCustomFields: a.include_custom_fields === true,
          includeClients:      a.include_clients       !== false,
        });
        const statusCount: Record<string,number> = {};
        const categoryCount: Record<string,number> = {};
        let resolvedInFirstCallCount = 0;
        let withSlaBreached = 0;
        const openStatuses = ['Novo','Em atendimento','Aguardando','Recorrente'];
        for (const t of result.tickets) {
          const s = t.status||'Desconhecido'; statusCount[s] = (statusCount[s]||0)+1;
          const c = t.category||'Sem categoria'; categoryCount[c] = (categoryCount[c]||0)+1;
          if (t.resolvedInFirstCall) resolvedInFirstCallCount++;
          if (t.slaSolutionDate && new Date(t.slaSolutionDate)<new Date() && openStatuses.includes(t.status||'')) withSlaBreached++;
        }
        return { content: [{ type: 'text', text: JSON.stringify({
          exportedAt: result.exportedAt, total: result.total, pages_fetched: result.pages,
          filters: { ...result.filters, dateFrom, dateTo },
          metricas_basicas: { por_status: statusCount, por_categoria: categoryCount, resolvidos_no_primeiro_contato: resolvedInFirstCallCount, tickets_com_sla_vencido: withSlaBreached },
          tickets: result.tickets,
        }, null, 2) }] };
      }

      case 'get_tickets_status_histories': {
        const { ticket_ids, concurrency } = args as any;
        if (!Array.isArray(ticket_ids) || ticket_ids.length === 0) throw new Error('ticket_ids deve ser um array nao vazio');
        const map = await movideskClient.fetchStatusHistoriesBatch(ticket_ids, concurrency || 5);
        return { content: [{ type: 'text', text: JSON.stringify({ total_processados: Object.keys(map).length, status_histories_map: map }, null, 2) }] };
      }

      case 'generate_metrics': {
        const { tickets, status_histories_map } = args as any;
        if (!Array.isArray(tickets) || tickets.length === 0) throw new Error('tickets deve ser um array nao vazio');
        const metricas = movideskClient.generateMetrics(tickets, status_histories_map || undefined);
        return { content: [{ type: 'text', text: JSON.stringify(metricas, null, 2) }] };
      }

      default:
        throw new Error(`Tool desconhecida: ${name}`);
    }
  } catch (error: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ status:'error', message: error.message }, null, 2) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Movidesk MCP v2.9 - Pronto!');
}
main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
