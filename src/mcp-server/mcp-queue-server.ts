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
  { name: 'movidesk-queue', version: '2.3.0' },
  { capabilities: { tools: {} } }
);

const N1_JUSTIFICATIVAS = ['Retorno do cliente', 'Retorno do newcon', 'Priorizacao'];

function loadPrompt(filename: string): string {
  const promptPath = path.join(__dirname, '../../prompts', filename);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt nao encontrado: ${filename}`);
  return fs.readFileSync(promptPath, 'utf-8');
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─── ORQUESTRADOR ────────────────────────────────────────
    {
      name: 'get_context',
      description: 'Carrega o contexto e apresentacao de um papel especifico. Use quando o usuario pedir para se contextualizar, ou quando um papel for acionado (n1, admin). Sem papel especifico, carrega o orquestrador com todas as opcoes.',
      inputSchema: {
        type: 'object',
        properties: {
          papel: {
            type: 'string',
            description: 'Papel a carregar: "orquestrador" (padrao), "n1" ou "admin"',
            enum: ['orquestrador', 'n1', 'admin'],
          },
        },
      },
    },
    // ─── N1 TOOLS ────────────────────────────────────────────
    {
      name: 'list_n1_tickets',
      description: 'N1: Lista tickets da fila N1 (Novo, Em atendimento, Aguardando com justificativas de retorno/priorizacao).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximo de tickets por grupo (padrao: 10)', default: 10 },
        },
      },
    },
    {
      name: 'analyze_ticket_n1',
      description: 'N1: Analisa UM ticket. Retorna contexto completo + prompt N1. Gere a analise, mostre ao usuario e peca aprovacao antes de criar nota.',
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
      description: 'N1: Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario. Nunca visivel ao cliente.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string', description: 'ID do ticket' },
          note_content: { type: 'string', description: 'Conteudo da nota interna' },
        },
        required: ['ticket_id', 'note_content'],
      },
    },
    // ─── ADMIN TOOLS ─────────────────────────────────────────
    {
      name: 'admin_list_tickets',
      description: 'ADMIN: Lista tickets do Movidesk. Filtra por status se informado (Novo, Em atendimento, Aguardando, Resolvido, Fechado, Cancelado) ou lista todos.',
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ─── ORQUESTRADOR ─────────────────────────────────────
      case 'get_context': {
        const papel = (args as any).papel || 'orquestrador';
        const arquivos: Record<string, string> = {
          orquestrador: 'ORQUESTRADOR.md',
          n1: 'PAPEL_N1.md',
          admin: 'PAPEL_ADMIN.md',
        };
        const prompt = loadPrompt(arquivos[papel] || 'ORQUESTRADOR.md');
        return {
          content: [{ type: 'text', text: prompt }],
        };
      }

      // ─── N1 ──────────────────────────────────────────────
      case 'list_n1_tickets': {
        const limit = Math.min((args as any).limit || 10, 50);
        const [novos, emAtendimento, aguardando] = await Promise.all([
          movideskClient.listTicketsByStatus('Novo', limit),
          movideskClient.listTicketsByStatus('Em atendimento', limit),
          movideskClient.listTicketsAguardandoN1(N1_JUSTIFICATIVAS, limit),
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
        const promptN1 = loadPrompt('N1_SUPPORT_AGENT.md');
        const descricao = ticket.actions && ticket.actions.length > 0
          ? ticket.actions[0].description : 'Sem descricao disponivel';
        return {
          content: [{
            type: 'text',
            text: `# TICKET ${ticketId}\n\n- **ID**: ${ticket.id}\n- **Assunto**: ${ticket.subject}\n- **Status**: ${ticket.status}\n- **Justification**: ${ticket.justification || 'N/A'}\n- **Criado em**: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Instrucoes\n\nAnalise o ticket seguindo o prompt N1 abaixo. Gere a orientacao para o analista e a resposta para o cliente. Mostre tudo ao usuario e pergunte: "Posso criar esta nota interna no ticket ${ticketId}?" Aguarde aprovacao antes de chamar create_note_approved.\n\n---\n\n${promptN1}`,
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

      // ─── ADMIN ───────────────────────────────────────────
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
                id: t.id,
                subject: t.subject,
                status: t.status,
                justification: t.justification || null,
                createdDate: t.createdDate,
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
        return {
          content: [{ type: 'text', text: JSON.stringify(ticket, null, 2) }],
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
  console.error('Movidesk MCP v2.3 - Orquestrador + N1 + Admin');
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
