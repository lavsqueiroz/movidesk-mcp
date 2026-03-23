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

const N1_JUSTIFICATIVAS = ['Retorno do cliente', 'Retorno do newcon', 'Priorizacao'];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_status_configs',
      description: 'Busca todos os status de tickets configurados no Movidesk, incluindo se exigem justificativa ou nao.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_n1_tickets',
      description: 'Lista tickets sob responsabilidade do agente N1: status Novo, Em atendimento, e Aguardando com justificativas Retorno do cliente / Retorno do newcon / Priorizacao.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximo de tickets por status (padrao: 10)', default: 10 },
        },
      },
    },
    {
      name: 'analyze_ticket_n1',
      description: 'Analisa UM ticket usando o agente N1. Retorna contexto + prompt N1. Gere a analise, mostre ao usuario e peca aprovacao antes de criar a nota.',
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
      description: 'Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario. A nota e sempre interna, nunca visivel ao cliente.',
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

      case 'get_status_configs': {
        const statuses = await movideskClient.getStatusConfigs();
        return { content: [{ type: 'text', text: JSON.stringify(statuses, null, 2) }] };
      }

      case 'list_n1_tickets': {
        const limit = Math.min((args as any).limit || 10, 50);
        const [novos, emAtendimento, aguardando] = await Promise.all([
          movideskClient.listTickets({ limit, status: 'Novo' }),
          movideskClient.listTickets({ limit, status: 'Em atendimento' }),
          movideskClient.listTicketsByJustificativas({ limit, justificativas: N1_JUSTIFICATIVAS }),
        ]);
        const todos = [
          ...novos.map(t => ({ ...t, _grupo: 'Novo' })),
          ...emAtendimento.map(t => ({ ...t, _grupo: 'Em atendimento' })),
          ...aguardando.map(t => ({ ...t, _grupo: 'Aguardando' })),
        ];
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total: todos.length,
              resumo: { novo: novos.length, em_atendimento: emAtendimento.length, aguardando_n1: aguardando.length },
              tickets: todos.map(t => ({
                id: t.id, subject: t.subject, status: t.status,
                justificativa: (t as any).justificativa || null,
                grupo: (t as any)._grupo, createdDate: t.createdDate,
              })),
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
            text: `# TICKET ${ticketId}\n\n- **ID**: ${ticket.id}\n- **Assunto**: ${ticket.subject}\n- **Status**: ${ticket.status}\n- **Justificativa**: ${(ticket as any).justificativa || 'N/A'}\n- **Criado em**: ${ticket.createdDate}\n\n## Descricao\n\n${descricao}\n\n---\n\n## Instrucoes\n\n1. Analise o ticket seguindo o prompt N1 abaixo\n2. Gere a orientacao para o analista e a resposta para o cliente\n3. Mostre o resultado ao usuario\n4. Pergunte: "Posso criar esta nota interna no ticket ${ticketId}?"\n5. Aguarde aprovacao antes de chamar create_note_approved\n\n---\n\n${promptN1}`,
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
