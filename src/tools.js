/**
 * src/tools.js
 * Definição das tools expostas pelo servidor MCP HTTP
 * Espelha exatamente o ListToolsRequestSchema do mcp-queue-server.ts
 */

export const TOOLS = [
  {
    name: 'get_context',
    description: 'Carrega o contexto completo de um papel.',
    inputSchema: {
      type: 'object',
      properties: {
        papel: {
          type: 'string',
          enum: ['orquestrador','n1','n2','n3','admin','gestor'],
        },
      },
    },
  },
  {
    name: 'list_n1_tickets',
    description: 'N1: Lista TODOS os tickets da fila N1.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'analyze_ticket_n1',
    description: 'N1: Busca dados completos de um ticket e carrega base de conhecimento N1.',
    inputSchema: {
      type: 'object',
      properties: { ticket_id: { type: 'string' } },
      required: ['ticket_id'],
    },
  },
  {
    name: 'create_note_approved',
    description: 'N1: Cria nota INTERNA no ticket. Use SOMENTE apos aprovacao explicita do usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id:    { type: 'string' },
        note_content: { type: 'string' },
      },
      required: ['ticket_id', 'note_content'],
    },
  },
  {
    name: 'admin_list_tickets',
    description: 'ADMIN: Lista tickets do Movidesk com filtro opcional de status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        limit:  { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'admin_get_ticket',
    description: 'ADMIN: Busca detalhes completos de um ticket pelo ID.',
    inputSchema: {
      type: 'object',
      properties: { ticket_id: { type: 'string' } },
      required: ['ticket_id'],
    },
  },
  {
    name: 'export_all_tickets',
    description:
      'RELATORIO/GESTOR: Exporta TODOS os tickets da janela de 90 dias da API do Movidesk. ' +
      'Sempre inclui actions. Filtro de status opcional (query). ' +
      'Filtro de data opcional (memoria). Retorna: total, periodo, resumo e tickets[].',
    inputSchema: {
      type: 'object',
      properties: {
        status:                { type: 'string',  description: 'Filtrar por status na API.' },
        date_from:             { type: 'string',  description: 'YYYY-MM-DD. Padrao: 60 dias atras.' },
        date_to:               { type: 'string',  description: 'YYYY-MM-DD. Padrao: hoje.' },
        include_custom_fields: { type: 'boolean', default: false },
        include_clients:       { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'get_tickets_status_histories',
    description: 'GESTOR (OPCIONAL): Busca statusHistories individualmente por ticket. Use apenas se total <= 150.',
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
      'Aceita tickets de qualquer origem. Se receber o objeto raiz do export, extrai tickets[] automaticamente.',
    inputSchema: {
      type: 'object',
      properties: {
        tickets:              { description: 'Array de tickets ou objeto raiz do export.' },
        status_histories_map: { type: 'object', description: 'Opcional. Do get_tickets_status_histories.' },
      },
      required: ['tickets'],
    },
  },
];
