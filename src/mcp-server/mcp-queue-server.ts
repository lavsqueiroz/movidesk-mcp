#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMovideskClient } from '../services/MovideskClient.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const movideskClient = getMovideskClient();

const server = new Server(
  { name: 'movidesk-queue', version: '2.7.0' },
  { capabilities: { tools: {} } }
);

// Justificativas N1 - nomes EXATOS conforme CSV exportado do Movidesk
const N1_JUSTIFICATIVAS = [
  'Retorno do cliente',
  'Retorno NewCon',
  'Priorizacao',
];

function loadPrompt(filename: string): string {
  const promptPath = path.join(__dirname, '../../prompts', filename);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt nao encontrado: ${filename}`);
  return fs.readFileSync(promptPath, 'utf-8');
}

function loadContext(papel: string): string {
  const arquivos: Record<string, string> = {
    orquestrador: 'ORQUESTRADOR.md',
    n1: 'Agentes/N1_PAPEL.md',
    n2: 'Agentes/N2_PAPEL.md',
    n3: 'Agentes/N3_PAPEL.md',
    admin: 'Agentes/ADMIN_PAPEL.md',
  };
  const papelContent = loadPrompt(arquivos[papel] || 'ORQUESTRADOR.md');
  const webhookContent = loadPrompt('Webhook/AGENTE_WEBHOOK.md');
  return `${papelContent}\n\n---\n\n${webhookContent}`;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_context',
      description: 'Carrega o contexto completo de um papel incluindo mapeamento de chamadas. Use sempre que o usuario pedir para se contextualizar ou acionar um papel.',
      inputSchema: {
        type: 'object',
        properties: {
          papel: {
            type: 'string',
            description: 'Papel a carregar: orquestrador (padrao), n1, n2, n3, admin',
            enum: ['orquestrador', 'n1', 'n2', 'n3', 'admin'],
          },
        },
      },
    },
    {
      name: 'list_n1_tickets',
      description: 'N1: Lista TODOS os tickets da fila N1 - status Novo, Em atendimento, e Aguardando com justificativas Retorno do cliente / Retorno NewCon / Priorizacao. Retorna todos sem limite.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'analyze_ticket_n1',
      description: 'N1: Busca dados completos de um ticket e carrega base de conhecimento N1. Use o retorno para gerar a analise, mostrar ao usuario e pedir aprovacao antes de criar nota.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string', description: 'ID do ticket do Movidesk' },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'create_note_approved',
      description: 'N1: Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario (sim, pode, aprovo, ok).',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string', description: 'ID do ticket' },
          note_content: { type: 'string', description: 'Conteudo completo da nota interna gerada' },
        },
        required: ['ticket_id', 'note_content'],
      },
    },
    {
      name: 'admin_list_tickets',
      description: 'ADMIN: Lista tickets do Movidesk. Informe status para filtrar (Novo, Em atendimento, Aguardando, Resolvido, Fechado, Cancelado, Recorrente) ou deixe vazio para todos.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Status para filtrar. Vazio = todos.' },
          limit: { type: 'number', description: 'Maximo de tickets (padrao: 50)', default: 50 },
        },
      },
    },
    {
      name: 'admin_get_ticket',
      description: 'ADMIN: Busca detalhes completos de um ticket pelo ID.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string', description: 'ID do ticket' },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'export_all_tickets',
      description: 'RELATORIO: Exporta TODOS os tickets do Movidesk com paginacao automatica e campos completos para montagem de relatorios e metricas. Suporta filtros por status e periodo. ATENCAO: pode demorar varios minutos dependendo do volume de tickets.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filtrar por status especifico (Novo, Em atendimento, Aguardando, Resolvido, Fechado, Cancelado, Recorrente). Omitir para buscar todos os status.',
          },
          date_from: {
            type: 'string',
            description: 'Data inicio para filtrar por createdDate (formato: YYYY-MM-DD, ex: 2024-01-01). Omitir para sem limite.',
          },
          date_to: {
            type: 'string',
            description: 'Data fim para filtrar por createdDate (formato: YYYY-MM-DD, ex: 2024-12-31). Omitir para sem limite.',
          },
          include_actions: {
            type: 'boolean',
            description: 'Se true, inclui historico completo de acoes/interacoes de cada ticket (muito mais pesado, pode ser lento). Padrao: false.',
            default: false,
          },
          include_custom_fields: {
            type: 'boolean',
            description: 'Se true, inclui valores de campos customizados. Padrao: false.',
            default: false,
          },
          include_clients: {
            type: 'boolean',
            description: 'Se true, inclui dados dos clientes vinculados ao ticket. Padrao: true.',
            default: true,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      case 'get_context': {
        const papel = (args as any).papel || 'orquestrador';
        const context = loadContext(papel);
        return { content: [{ type: 'text', text: context }] };
      }

      case 'list_n1_tickets': {
        const [novos, emAtendimento, aguardando] = await Promise.all([
          movideskClient.listTicketsByStatus('Novo'),
          movideskClient.listTicketsByStatus('Em atendimento'),
          movideskClient.listTicketsAguardandoN1(N1_JUSTIFICATIVAS),
        ]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: novos.length + emAtendimento.length + aguardando.length,
              resumo: {
                novo: novos.length,
                em_atendimento: emAtendimento.length,
                aguardando_n1: aguardando.length,
              },
              tickets: [
                ...novos.map(t => ({ ...t, grupo: 'Novo' })),
                ...emAtendimento.map(t => ({ ...t, grupo: 'Em atendimento' })),
                ...aguardando.map(t => ({ ...t, grupo: 'Aguardando' })),
              ],
            }, null, 2),
          }],
        };
      }

      case 'analyze_ticket_n1': {
        const ticketId = (args as any).ticket_id;
        if (!ticketId) throw new Error('ticket_id e obrigatorio');
        const ticket = await movideskClient.getTicket(ticketId);
        if (!ticket) throw new Error(`Ticket ${ticketId} nao encontrado`);
        const n1Papel = loadPrompt('Agentes/N1_PAPEL.md');
        const descricao = ticket.actions && ticket.actions.length > 0
          ? ticket.actions[0].description : 'Sem descricao disponivel';
        return {
          content: [{
            type: 'text',
            text: `# DADOS DO TICKET ${ticketId}\n\n- ID: ${ticket.id}\n- Assunto: ${ticket.subject}\n- Status: ${ticket.status}\n- Justification: ${ticket.justification || 'N/A'}\n- Criado em: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Base de Conhecimento N1\n\n${n1Papel}`,
          }],
        };
      }

      case 'create_note_approved': {
        const ticketId = (args as any).ticket_id;
        const noteContent = (args as any).note_content;
        if (!ticketId || !noteContent) throw new Error('ticket_id e note_content sao obrigatorios');
        const success = await movideskClient.createInternalNote({ ticketId, description: noteContent, isInternal: true });
        if (success) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'success',
                message: `Nota criada com sucesso no ticket ${ticketId}`,
                ticket_url: `https://newm.movidesk.com/Ticket/Edit/${ticketId}`,
              }, null, 2),
            }],
          };
        }
        throw new Error('Falha ao criar nota');
      }

      case 'admin_list_tickets': {
        const status = (args as any).status || null;
        const limit = Math.min((args as any).limit || 50, 200);
        const tickets = await movideskClient.adminListTickets(status, limit);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: tickets.length,
              filtro_status: status || 'todos',
              tickets: tickets.map(t => ({
                id: t.id, subject: t.subject, status: t.status,
                justification: t.justification || null, createdDate: t.createdDate,
              })),
            }, null, 2),
          }],
        };
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
        const result = await movideskClient.exportAllTickets({
          status: a.status || null,
          dateFrom: a.date_from || null,
          dateTo: a.date_to || null,
          includeActions: a.include_actions === true,
          includeCustomFields: a.include_custom_fields === true,
          includeClients: a.include_clients !== false, // padrao true
        });

        // Monta resumo de metricas basicas junto com os dados brutos
        const statusCount: Record<string, number> = {};
        const categoryCount: Record<string, number> = {};
        const ownerTeamCount: Record<string, number> = {};
        let resolvedInFirstCallCount = 0;
        let withSlaBreached = 0;

        for (const t of result.tickets) {
          // Contagem por status
          const s = t.status || 'Desconhecido';
          statusCount[s] = (statusCount[s] || 0) + 1;

          // Contagem por categoria
          const c = t.category || 'Sem categoria';
          categoryCount[c] = (categoryCount[c] || 0) + 1;

          // Contagem por equipe
          const ot = t.ownerTeam || 'Sem equipe';
          ownerTeamCount[ot] = (ownerTeamCount[ot] || 0) + 1;

          // Resolvidos no primeiro contato
          if (t.resolvedInFirstCall) resolvedInFirstCallCount++;

          // SLA vencido (slaSolutionDate < now e status nao eh Resolvido/Fechado/Cancelado)
          const openStatuses = ['Novo', 'Em atendimento', 'Aguardando', 'Recorrente'];
          if (
            t.slaSolutionDate &&
            new Date(t.slaSolutionDate) < new Date() &&
            openStatuses.includes(t.status || '')
          ) {
            withSlaBreached++;
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              exportedAt: result.exportedAt,
              total: result.total,
              pages_fetched: result.pages,
              filters: result.filters,
              metricas_basicas: {
                por_status: statusCount,
                por_categoria: categoryCount,
                por_equipe: ownerTeamCount,
                resolvidos_no_primeiro_contato: resolvedInFirstCallCount,
                tickets_com_sla_vencido: withSlaBreached,
              },
              tickets: result.tickets,
            }, null, 2),
          }],
        };
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
  console.error('Movidesk MCP v2.7 - Pronto!');
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
