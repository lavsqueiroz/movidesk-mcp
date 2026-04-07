/**
 * Movidesk API Client
 * Documentacao: https://atendimento.movidesk.com/kb/pt-br/article/256/movidesk-ticket-api
 *
 * Campos confirmados pela documentacao:
 * - id, protocol, subject, status, justification, createdDate
 * - $select obrigatorio ao listar multiplos tickets
 * - $filter suporta OData: status eq 'Novo'
 * - $top: limite de registros por request (max 1000)
 * - $skip: paginacao
 * - Nota INTERNA: action type=1 (Interna), isInternal=true, id=0 (nova action)
 * - Nota PUBLICA: action type=2 (Publica)
 * - Rota /tickets retorna tickets com lastupdate < 90 dias
 */

import axios, { AxiosInstance } from 'axios';

export interface MovideskTicket {
  id: string;
  protocol?: string;
  subject?: string;
  status?: string;
  justification?: string;
  createdDate?: string;
  actions?: any[];
}

export interface MovideskTicketFull {
  id: string;
  protocol?: string;
  subject?: string;
  status?: string;
  justification?: string;
  baseStatus?: string;
  createdDate?: string;
  lastUpdate?: string;
  resolvedIn?: string;
  closedIn?: string;
  canceledIn?: string;
  origin?: number;
  originEmailAccount?: string;
  type?: number;
  urgency?: number;
  category?: string;
  owner?: any;
  ownerTeam?: string;
  createdBy?: any;
  clients?: any[];
  actions?: any[];
  customFieldValues?: any[];
  tags?: string[];
  slaSolutionDate?: string;
  slaSolutionDateIsPaused?: boolean;
  slaResponseDate?: string;
  lifeTimeWorkingTime?: number;
  stoppedTime?: number;
  stoppedTimeWorkingTime?: number;
  resolvedInFirstCall?: boolean;
  chatWidget?: string;
  chatGroup?: string;
  chatTalk?: string;
  reopenedIn?: string;
}

export interface ExportAllTicketsParams {
  status?: string | null;
  dateFrom?: string | null;      // ISO date: '2024-01-01'
  dateTo?: string | null;        // ISO date: '2024-12-31'
  includeActions?: boolean;      // incluir historico de acoes (pesado)
  includeCustomFields?: boolean; // incluir campos customizados
  includeClients?: boolean;      // incluir dados de clientes
}

export interface ExportAllTicketsResult {
  total: number;
  pages: number;
  filters: Record<string, any>;
  exportedAt: string;
  tickets: MovideskTicketFull[];
}

interface CreateNoteParams {
  ticketId: string;
  description: string;
  isInternal: boolean;
}

// Campos base para relatorios (sem actions — mais leve)
const SELECT_REPORT_BASE = [
  'id', 'protocol', 'subject', 'status', 'baseStatus', 'justification',
  'type', 'urgency', 'origin', 'category',
  'createdDate', 'lastUpdate', 'resolvedIn', 'closedIn', 'canceledIn', 'reopenedIn',
  'slaSolutionDate', 'slaSolutionDateIsPaused', 'slaResponseDate',
  'lifeTimeWorkingTime', 'stoppedTime', 'stoppedTimeWorkingTime',
  'resolvedInFirstCall', 'ownerTeam', 'owner', 'createdBy',
  'tags',
].join(',');

const SELECT_WITH_CLIENTS = SELECT_REPORT_BASE + ',clients';
const SELECT_WITH_CUSTOM = SELECT_REPORT_BASE + ',customFieldValues';
const SELECT_FULL = SELECT_REPORT_BASE + ',clients,customFieldValues,actions';

export class MovideskClient {
  private httpClient: AxiosInstance;
  private token: string;

  constructor() {
    this.token = process.env.MOVIDESK_TOKEN || '';
    if (!this.token) throw new Error('MOVIDESK_TOKEN nao configurado');

    this.httpClient = axios.create({
      baseURL: 'https://api.movidesk.com/public/v1',
      timeout: 60000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async listTicketsByStatus(status: string): Promise<MovideskTicket[]> {
    try {
      console.error(`Buscando tickets status=${status}...`);
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq '${status}'`,
          $top: 1000,
        },
      });
      const tickets = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${tickets.length} tickets com status=${status}`);
      return tickets;
    } catch (error: any) {
      console.error('Erro ao listar tickets:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  async listTicketsAguardandoN1(justificativas: string[]): Promise<MovideskTicket[]> {
    try {
      console.error('Buscando tickets Aguardando N1...');
      const response = await this.httpClient.get('/tickets', {
        params: {
          token: this.token,
          $select: 'id,protocol,subject,status,justification,createdDate',
          $filter: `status eq 'Aguardando'`,
          $top: 1000,
        },
      });

      const all = Array.isArray(response.data) ? response.data : [response.data];
      const filtered = all.filter((t: any) =>
        justificativas.some(j =>
          j.toLowerCase() === (t.justification || '').toLowerCase()
        )
      );

      console.error(`${filtered.length} tickets Aguardando N1 (de ${all.length} Aguardando total)`);
      return filtered;
    } catch (error: any) {
      console.error('Erro:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  async adminListTickets(status: string | null, limit: number = 50): Promise<MovideskTicket[]> {
    try {
      console.error(`ADMIN: Buscando tickets... status=${status || 'todos'}`);

      const params: any = {
        token: this.token,
        $select: 'id,protocol,subject,status,justification,createdDate',
        $top: limit,
      };

      if (status) {
        params.$filter = `status eq '${status}'`;
      }

      const response = await this.httpClient.get('/tickets', { params });
      const tickets = Array.isArray(response.data) ? response.data : [response.data];
      console.error(`${tickets.length} tickets retornados`);
      return tickets;
    } catch (error: any) {
      console.error('Erro ADMIN:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      throw error;
    }
  }

  async getTicket(ticketId: string): Promise<MovideskTicket | null> {
    try {
      const response = await this.httpClient.get('/tickets', {
        params: { token: this.token, id: ticketId },
      });
      return response.data;
    } catch (error: any) {
      console.error(`Erro ao buscar ticket ${ticketId}:`, error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      return null;
    }
  }

  /**
   * Exporta TODOS os tickets com paginacao automatica.
   * Usa $skip + $top=1000 para iterar sobre todas as paginas.
   *
   * ATENCAO: A API do Movidesk retorna apenas tickets com lastUpdate nos ultimos 90 dias
   * quando nenhum filtro de data e aplicado. Para historico completo, use dateFrom.
   *
   * Campos retornados variam conforme os parametros:
   * - includeActions=true  => inclui historico completo de acoes (muito mais pesado)
   * - includeClients=true  => inclui dados dos clientes do ticket
   * - includeCustomFields=true => inclui campos customizados
   */
  async exportAllTickets(params: ExportAllTicketsParams = {}): Promise<ExportAllTicketsResult> {
    const {
      status = null,
      dateFrom = null,
      dateTo = null,
      includeActions = false,
      includeCustomFields = false,
      includeClients = true,
    } = params;

    // Monta $select conforme opcoes
    let selectFields: string;
    if (includeActions) {
      selectFields = SELECT_FULL;
    } else if (includeClients && includeCustomFields) {
      selectFields = SELECT_REPORT_BASE + ',clients,customFieldValues';
    } else if (includeClients) {
      selectFields = SELECT_WITH_CLIENTS;
    } else if (includeCustomFields) {
      selectFields = SELECT_WITH_CUSTOM;
    } else {
      selectFields = SELECT_REPORT_BASE;
    }

    // Monta filtros OData
    const filters: string[] = [];
    if (status) filters.push(`status eq '${status}'`);
    if (dateFrom) filters.push(`createdDate ge '${dateFrom}T00:00:00'`);
    if (dateTo) filters.push(`createdDate le '${dateTo}T23:59:59'`);
    const $filter = filters.length > 0 ? filters.join(' and ') : undefined;

    const PAGE_SIZE = 1000;
    let skip = 0;
    let page = 1;
    let allTickets: MovideskTicketFull[] = [];
    let hasMore = true;

    console.error(`EXPORT: Iniciando exportacao total. Filtros: ${JSON.stringify({ status, dateFrom, dateTo })}`);

    while (hasMore) {
      console.error(`EXPORT: Buscando pagina ${page} (skip=${skip})...`);

      const requestParams: any = {
        token: this.token,
        $select: selectFields,
        $top: PAGE_SIZE,
        $skip: skip,
        $orderby: 'createdDate asc',
      };

      if ($filter) requestParams.$filter = $filter;

      try {
        const response = await this.httpClient.get('/tickets', { params: requestParams });
        const data = Array.isArray(response.data) ? response.data : [response.data];

        if (data.length === 0 || (data.length === 1 && !data[0]?.id)) {
          hasMore = false;
          console.error(`EXPORT: Fim da paginacao na pagina ${page} (0 resultados)`);
          break;
        }

        allTickets = allTickets.concat(data);
        console.error(`EXPORT: Pagina ${page} -> ${data.length} tickets | Total acumulado: ${allTickets.length}`);

        // Se retornou menos que PAGE_SIZE, chegamos ao fim
        if (data.length < PAGE_SIZE) {
          hasMore = false;
        } else {
          skip += PAGE_SIZE;
          page++;
          // Pequena pausa para nao sobrecarregar a API
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (error: any) {
        console.error(`EXPORT: Erro na pagina ${page}:`, error.message);
        if (error.response) {
          console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
        }
        // Se falhar em uma pagina intermediaria, retorna o que ja tem
        hasMore = false;
      }
    }

    console.error(`EXPORT: Concluido! Total de ${allTickets.length} tickets em ${page} paginas.`);

    return {
      total: allTickets.length,
      pages: page,
      filters: {
        status: status || 'todos',
        dateFrom: dateFrom || 'sem filtro',
        dateTo: dateTo || 'sem filtro',
        includeActions,
        includeCustomFields,
        includeClients,
      },
      exportedAt: new Date().toISOString(),
      tickets: allTickets,
    };
  }

  /**
   * Cria nota INTERNA no ticket.
   *
   * CONFIRMADO PELA DOCUMENTACAO OFICIAL:
   * action.type = 1  => Interna (nao visivel ao cliente)
   * action.type = 2  => Publica (visivel ao cliente)
   *
   * Usamos type=1 para garantir que a nota e sempre interna.
   */
  async createInternalNote(params: CreateNoteParams): Promise<boolean> {
    try {
      console.error(`Criando nota INTERNA no ticket ${params.ticketId}`);
      const action = {
        id: 0,        // 0 = nova action (nao alteracao)
        type: 1,      // 1 = INTERNA (confirmado pela doc oficial)
        description: params.description,
        isInternal: true,
      };
      await this.httpClient.patch(
        `/tickets`,
        { id: params.ticketId, actions: [action] },
        { params: { token: this.token, id: params.ticketId } }
      );
      console.error('Nota interna criada com sucesso');
      return true;
    } catch (error: any) {
      console.error('Erro ao criar nota:', error.message);
      if (error.response) console.error('HTTP:', error.response.status, JSON.stringify(error.response.data));
      return false;
    }
  }
}

let instance: MovideskClient | null = null;
export function getMovideskClient(): MovideskClient {
  if (!instance) instance = new MovideskClient();
  return instance;
}
