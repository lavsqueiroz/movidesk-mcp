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
  { name: 'movidesk-queue', version: '2.9.4' },
  { capabilities: { tools: {} } }
);

const N1_JUSTIFICATIVAS = ['Retorno do cliente','Retorno NewCon','Priorizacao'];

// Mapa de urgencia: numero da API -> label legivel
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
function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
      description: 'RELATORIO/GESTOR: Exporta tickets do Movidesk com paginacao automatica filtrado por lastUpdate. PADRAO: ultimos 60 dias, actions incluidas (necessario para metricas). Retorna: metadados, campo resumo com dados pre-calculados em horas, e array tickets[].',
      inputSchema: {
        type: 'object',
        properties: {
          status:               { type: 'string',  description: 'Filtrar por status. Omitir para todos.' },
          date_from:            { type: 'string',  description: 'Data inicio YYYY-MM-DD. Padrao: 60 dias atras.' },
          date_to:              { type: 'string',  description: 'Data fim YYYY-MM-DD. Padrao: hoje.' },
          include_actions:      { type: 'boolean', description: 'Incluir actions. Padrao: true (necessario para metricas).' },
          include_custom_fields:{ type: 'boolean', default: false },
          include_clients:      { type: 'boolean', default: true  },
        },
      },
    },
    {
      name: 'get_tickets_status_histories',
      description: 'GESTOR: Busca statusHistories individuais (uma req por ticket). Use somente para volumes ate 150 tickets. Retorna status_histories_map para passar ao generate_metrics.',
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
      description: 'GESTOR: Calcula metricas detalhadas de desempenho. Recebe o array tickets[] do export_all_tickets (campo tickets, nao o objeto raiz). status_histories_map e opcional. Se passar o objeto raiz do export por engano, extrai tickets[] automaticamente.',
      inputSchema: {
        type: 'object',
        // Aceita qualquer objeto para maxima compatibilidade — validacao feita no handler
        properties: {
          tickets:              { description: 'Array tickets[] do export_all_tickets ou o objeto raiz completo (extraido automaticamente).' },
          status_histories_map: { type: 'object', description: 'Opcional. Retorno do get_tickets_status_histories.' },
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
            ...novos.map(t => ({ ...t, grupo: 'Novo' })),
            ...emAt.map(t  => ({ ...t, grupo: 'Em atendimento' })),
            ...aguard.map(t => ({ ...t, grupo: 'Aguardando' })),
          ],
        }, null, 2) }] };
      }

      case 'analyze_ticket_n1': {
        const ticketId = (args as any).ticket_id;
        if (!ticketId) throw new Error('ticket_id e obrigatorio');
        const ticket = await movideskClient.getTicket(ticketId);
        if (!ticket) throw new Error(`Ticket ${ticketId} nao encontrado`);
        const n1Papel = loadPrompt('Agentes/N1_PAPEL.md');
        const descricao = (ticket as any).actions?.length ? (ticket as any).actions[0].description : 'Sem descricao';
        return { content: [{ type: 'text', text:
          `# TICKET ${ticketId}\n\n- ID: ${ticket.id}\n- Assunto: ${ticket.subject}\n- Status: ${ticket.status}\n` +
          `- Justification: ${ticket.justification||'N/A'}\n- Criado: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Base N1\n\n${n1Papel}`
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
        const limit = Math.min((args as any).limit || 50, 200);
        const tickets = await movideskClient.adminListTickets(status, limit);
        return { content: [{ type: 'text', text: JSON.stringify({
          total: tickets.length,
          filtro_status: status || 'todos',
          tickets: tickets.map(t => ({ id: t.id, subject: t.subject, status: t.status, justification: t.justification || null, createdDate: t.createdDate })),
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
        // actions ligadas por padrao — necessarias para metricas
        const includeActions = a.include_actions !== false;

        const result = await movideskClient.exportAllTickets({
          status:              a.status || null,
          dateFrom,
          dateTo,
          includeActions,
          includeCustomFields: a.include_custom_fields === true,
          includeClients:      a.include_clients !== false,
        });

        // --- Metricas de resumo pre-calculadas (prontas para uso direto no HTML) ---
        const statusCount:   Record<string, number> = {};
        const categoryCount: Record<string, number> = {};
        const urgencyCount:  Record<string, number> = {}; // com labels legíveis
        const volumeMensal:  Record<string, number> = {};
        let resolvedInFirstCallCount = 0;
        let withSlaBreached = 0;
        const openStatuses = ['Novo', 'Em atendimento', 'Aguardando', 'Recorrente'];

        for (const t of result.tickets) {
          // Status
          const s = t.status || 'Desconhecido';
          statusCount[s] = (statusCount[s] || 0) + 1;

          // Categoria
          const c = t.category || 'Sem categoria';
          categoryCount[c] = (categoryCount[c] || 0) + 1;

          // Urgencia: converte numero para label legivel
          const uLabel = (t.urgency != null && URGENCY_LABELS[t.urgency])
            ? URGENCY_LABELS[t.urgency]
            : (t.urgency != null ? String(t.urgency) : 'N/D');
          urgencyCount[uLabel] = (urgencyCount[uLabel] || 0) + 1;

          // Resolvido no 1o contato
          if (t.resolvedInFirstCall) resolvedInFirstCallCount++;

          // SLA vencido
          if (t.slaSolutionDate && new Date(t.slaSolutionDate) < new Date() && openStatuses.includes(t.status || '')) {
            withSlaBreached++;
          }

          // Volume mensal por createdDate (YYYY-MM)
          if (t.createdDate) {
            const d = new Date(t.createdDate);
            const mesAno = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            volumeMensal[mesAno] = (volumeMensal[mesAno] || 0) + 1;
          }
        }

        // Tempo medio de vida e parado — convertidos de minutos para horas
        const lifeHours    = result.tickets.filter(t => t.lifeTimeWorkingTime    != null).map(t => t.lifeTimeWorkingTime!    / 60);
        const stoppedHours = result.tickets.filter(t => t.stoppedTimeWorkingTime != null).map(t => t.stoppedTimeWorkingTime! / 60);

        // Distribuicao tempo ate fechamento (baseado no lifeTimeWorkingTime em horas)
        const distFechamento = { ate_24h: 0, d1_3: 0, d3_7: 0, mais_7d: 0 };
        for (const t of result.tickets) {
          if (t.lifeTimeWorkingTime == null) continue;
          const h = t.lifeTimeWorkingTime / 60;
          if (h <= 24)       distFechamento.ate_24h++;
          else if (h <= 72)  distFechamento.d1_3++;
          else if (h <= 168) distFechamento.d3_7++;
          else               distFechamento.mais_7d++;
        }

        // Tempo abertura -> fechamento (em horas, usando datas reais de closedIn/resolvedIn)
        const abFechHoras: number[] = [];
        for (const t of result.tickets) {
          const fim = t.closedIn || t.resolvedIn;
          if (t.createdDate && fim) {
            const h = (new Date(fim).getTime() - new Date(t.createdDate).getTime()) / 3_600_000;
            if (h > 0) abFechHoras.push(h);
          }
        }

        return { content: [{ type: 'text', text: JSON.stringify({
          // Metadados
          exportedAt:    result.exportedAt,
          total:         result.total,
          pages_fetched: result.pages,
          periodo:       { dateFrom, dateTo },
          filters:       { ...result.filters, dateFrom, dateTo },

          // Resumo pre-calculado — todos os valores de tempo JA EM HORAS
          // Claude deve usar esses valores diretamente no HTML sem converter
          resumo: {
            total_tickets:                       result.total,
            por_status:                          statusCount,
            por_categoria:                       categoryCount,
            por_urgencia:                        urgencyCount,  // labels: Simples, Moderado, Importante, Grave
            resolvidos_no_primeiro_contato:      resolvedInFirstCallCount,
            tickets_com_sla_vencido:             withSlaBreached,
            volume_mensal:                       volumeMensal,  // chave YYYY-MM, valor contagem
            tempo_medio_vida_horas:              round2(avg(lifeHours)),
            tempo_medio_parado_horas:            round2(avg(stoppedHours)),
            tempo_medio_abertura_fechamento_horas: round2(avg(abFechHoras.map(h => Math.round(h)))),
            distribuicao_tempo_fechamento:       distFechamento,
            tickets_com_data_fechamento:         result.tickets.filter(t => t.closedIn || t.resolvedIn).length,
          },

          // Array bruto — passe tickets[] para generate_metrics
          tickets: result.tickets,
        }, null, 2) }] };
      }

      case 'get_tickets_status_histories': {
        const { ticket_ids, concurrency } = args as any;
        if (!Array.isArray(ticket_ids) || ticket_ids.length === 0)
          throw new Error('ticket_ids deve ser um array nao vazio');
        if (ticket_ids.length > 200)
          console.error(`STATUS_HIST: AVISO — ${ticket_ids.length} tickets. Pode demorar varios minutos.`);
        const map = await movideskClient.fetchStatusHistoriesBatch(ticket_ids, Math.min(concurrency || 5, 8));
        return { content: [{ type: 'text', text: JSON.stringify({
          total_processados:    Object.keys(map).length,
          status_histories_map: map,
        }, null, 2) }] };
      }

      case 'generate_metrics': {
        const { tickets, status_histories_map } = args as any;

        // Auto-detect: aceita tanto o array direto quanto o objeto raiz do export
        let ticketArray = tickets;
        if (!Array.isArray(tickets)) {
          if (tickets?.tickets && Array.isArray(tickets.tickets)) {
            ticketArray = tickets.tickets;
            console.error('METRICS: objeto raiz recebido — extraindo tickets[] automaticamente.');
          } else {
            throw new Error('tickets deve ser o array tickets[] do export_all_tickets, ou o objeto raiz completo do export.');
          }
        }
        if (ticketArray.length === 0)
          throw new Error('Nenhum ticket no array fornecido.');

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
  console.error('Movidesk MCP v2.9.4 - Pronto!');
}
main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
