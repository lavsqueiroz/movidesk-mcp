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
  { name: 'movidesk-queue', version: '2.1.0' },
  { capabilities: { tools: {} } }
);

// Justificativas do status Aguardando que pertencem ao N1
const N1_JUSTIFICATIVAS = ['Retorno do cliente', 'Retorno do newcon', 'Priorizacao'];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_n1_tickets',
      description: 'Lista tickets sob responsabilidade do N1: Novo, Em atendimento, e Aguardando com justificativas de retorno do cliente/newcon/priorizacao.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximo de tickets por grupo (padrao: 10)', default: 10 },
        },
      },
    },
    {
      name: 'analyze_ticket_n1',
      description: 'Analisa UM ticket usando o agente N1. Passe o ID do ticket. Gera orientacao para o analista e resposta para o cliente. Pede aprovacao antes de criar nota.',
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
      description: 'Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario. Nunca visivel ao cliente.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'string', description: 'ID do ticket' },
          note_content: { type: 'string', description: 'Conteudo da nota interna' },
        },
        required: ['ticket_id', 'note_content'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

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
        const promptPath = path.join(__dirname, '../../prompts/N1_SUPPORT_AGENT.md');
        const promptN1 = fs.readFileSync(promptPath, 'utf-8');
        const descricao = ticket.actions && ticket.actions.length > 0
          ? ticket.actions[0].description : 'Sem descricao disponivel';
        return {
          content: [{
            type: 'text',
            text: `# TICKET ${ticketId}\n\n- **ID**: ${ticket.id}\n- **Assunto**: ${ticket.subject}\n- **Status**: ${ticket.status}\n- **Justificativa**: ${ticket.justification || 'N/A'}\n- **Criado em**: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Instrucoes\n\nAnalise o ticket seguindo o prompt N1 abaixo. Gere a orientacao para o analista e a resposta para o cliente. Mostre tudo ao usuario e pergunte: "Posso criar esta nota interna no ticket ${ticketId}?" Aguarde aprovacao antes de chamar create_note_approved.\n\n---\n\n${promptN1}`,
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
  console.error('Movidesk MCP v2.1 - Pronto!');
}

main().catch((error) => {
  console.error('Erro fatal:', error);
  process.exit(1);
});
