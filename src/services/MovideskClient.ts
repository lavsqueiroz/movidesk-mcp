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
  dateFrom?: string | null;
  dateTo?: string | null;
  includeActions?: boolean;
  includeCustomFields?: boolean;
  includeClients?: boolean;
}

export interface ExportAllTicketsResult {
  total: number;
  pages: number;
  filters: Record<string, any>;
  exportedAt: string;
  tickets: MovideskTicketFull[];
}

// ---- Tipos para metricas ----
export interface TempoStats {
  media_horas: number;
  minimo_horas: number;
  maximo_horas: number;
  amostras: number;
}

export interface DistribuicaoFaixa {
  ate_2h: number;
  de_2h_a_8h: number;
  de_8h_a_24h: number;
  acima_24h: number;
}

export interface MetricasResult {
  gerado_em: string;
  total_tickets: number;
  periodo: { mais_antigo: string | null; mais_recente: string | null };

  tempo_resposta_cliente: TempoStats & { distribuicao_por_faixa: DistribuicaoFaixa };
  tempo_em_atendimento: TempoStats;
  tempo_aguardando_retorno_cliente: TempoStats;
  tempo_triagem_ate_analise_projetos: TempoStats;
  percentual_volta_falta_info: {
    quantidade: number;
    percentual: number;
    justificativas_encontradas: string[];
  };
  tempo_em_analise_projetos: TempoStats;
  tempo_retorno_com_direcionamento: TempoStats;
  interacoes_com_cliente: {
    media_por_ticket: number;
    maximo: number;
    ticket_mais_interacoes: string | null;
    distribuicao: Record<string, number>;
  };
  tickets_encerrados: {
    resolvidos: number;
    fechados: number;
    total_encerrados: number;
    percentual_sobre_total: number;
  };
}

interface CreateNoteParams {
  ticketId: string;
  description: string;
  isInternal: boolean;
}

// Campos base para relatorios
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
const SELECT_WITH_CUSTOM  = SELECT_REPORT_BASE + ',customFieldValues';
const SELECT_FULL         = SELECT_REPORT_BASE + ',clients,customFieldValues,actions';

// ---- Helpers de tempo ----
function diffHoras(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (isNaN(da) || isNaN(db)) return null;
  return Math.abs(db - da) / 3_600_000;
}

function statsDeArray(valores: number[]): TempoStats {
  if (valores.length === 0) return { media_horas: 0, minimo_horas: 0, maximo_horas: 0, amostras: 0 };
  const soma = valores.reduce((s, v) => s + v, 0);
  return {
    media_horas: Math.round((soma / valores.length) * 100) / 100,
    minimo_horas: Math.round(Math.min(...valores) * 100) / 100,
    maximo_horas: Math.round(Math.max(...valores) * 100) / 100,
    amostras: valores.length,
  };
}

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
        justificativas.some(j => j.toLowerCase() === (t.justification || '').toLowerCase())
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
      if (status) params.$filter = `status eq '${status}'`;
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

  async exportAllTickets(params: ExportAllTicketsParams = {}): Promise<ExportAllTicketsResult> {
    const {
      status = null, dateFrom = null, dateTo = null,
      includeActions = false, includeCustomFields = false, includeClients = true,
    } = params;

    let selectFields: string;
    if (includeActions)                          selectFields = SELECT_FULL;
    else if (includeClients && includeCustomFields) selectFields = SELECT_REPORT_BASE + ',clients,customFieldValues';
    else if (includeClients)                     selectFields = SELECT_WITH_CLIENTS;
    else if (includeCustomFields)                selectFields = SELECT_WITH_CUSTOM;
    else                                         selectFields = SELECT_REPORT_BASE;

    const filters: string[] = [];
    if (status)   filters.push(`status eq '${status}'`);
    if (dateFrom) filters.push(`createdDate ge '${dateFrom}T00:00:00'`);
    if (dateTo)   filters.push(`createdDate le '${dateTo}T23:59:59'`);
    const $filter = filters.length > 0 ? filters.join(' and ') : undefined;

    const PAGE_SIZE = 1000;
    let skip = 0, page = 1;
    let allTickets: MovideskTicketFull[] = [];
    let hasMore = true;

    console.error(`EXPORT: Iniciando exportacao total. Filtros: ${JSON.stringify({ status, dateFrom, dateTo })}`);

    while (hasMore) {
      console.error(`EXPORT: Buscando pagina ${page} (skip=${skip})...`);
      const requestParams: any = {
        token: this.token, $select: selectFields,
        $top: PAGE_SIZE, $skip: skip, $orderby: 'createdDate asc',
      };
      if ($filter) requestParams.$filter = $filter;

      try {
        const response = await this.httpClient.get('/tickets', { params: requestParams });
        const data = Array.isArray(response.data) ? response.data : [response.data];
        if (data.length === 0 || (data.length === 1 && !data[0]?.id)) { hasMore = false; break; }
        allTickets = allTickets.concat(data);
        console.error(`EXPORT: Pagina ${page} -> ${data.length} tickets | Total: ${allTickets.length}`);
        if (data.length < PAGE_SIZE) { hasMore = false; }
        else { skip += PAGE_SIZE; page++; await new Promise(r => setTimeout(r, 300)); }
      } catch (error: any) {
        console.error(`EXPORT: Erro na pagina ${page}:`, error.message);
        hasMore = false;
      }
    }

    console.error(`EXPORT: Concluido! ${allTickets.length} tickets em ${page} paginas.`);
    return {
      total: allTickets.length, pages: page,
      filters: { status: status || 'todos', dateFrom: dateFrom || 'sem filtro', dateTo: dateTo || 'sem filtro', includeActions, includeCustomFields, includeClients },
      exportedAt: new Date().toISOString(),
      tickets: allTickets,
    };
  }

  /**
   * Calcula metricas de desempenho do suporte a partir de uma lista de tickets.
   *
   * Logica das metricas:
   * - tempo_resposta_cliente: createdDate -> primeira action publica (type=2)
   * - tempo_em_atendimento: soma de periodos com status 'Em atendimento' via actions
   * - tempo_aguardando_retorno_cliente: periodos com justification contendo 'Retorno'
   * - tempo_triagem_ate_analise_projetos: createdDate -> primeira action que move p/ 'Analise Projetos'
   * - volta_falta_info: tickets com justification contendo 'falta de informacao' ou 'info' reabertos
   * - tempo_em_analise_projetos: periodos com status 'Analise Projetos'
   * - tempo_retorno_com_direcionamento: createdDate -> primeira action publica apos analise
   * - interacoes_cliente: contagem de actions publicas por ticket
   * - encerrados: tickets com status Resolvido ou Fechado
   */
  generateMetrics(tickets: MovideskTicketFull[]): MetricasResult {
    console.error(`METRICS: Calculando metricas para ${tickets.length} tickets...`);

    const JUSTIFICATIVAS_FALTA_INFO = [
      'falta de informacao', 'falta informacao', 'aguardando informacao',
      'info incompleta', 'sem informacao', 'informacao pendente',
    ];
    const STATUS_ANALISE = 'Analise Projetos';
    const STATUS_EM_ATENDIMENTO = 'Em atendimento';
    const STATUS_AGUARDANDO = 'Aguardando';

    // Arrays para acumular valores
    const temposResposta:          number[] = [];
    const temposEmAtendimento:     number[] = [];
    const temposAguardandoRetorno: number[] = [];
    const temposTriagem:           number[] = [];
    const temposAnalise:           number[] = [];
    const temposDirecionamento:    number[] = [];
    const interacoesPorTicket:     { id: string; count: number }[] = [];

    let voltaFaltaInfo = 0;
    const justificativasEncontradas = new Set<string>();
    let resolvidos = 0;
    let fechados   = 0;

    const distribuicaoInteracoes: Record<string, number> = {
      '0': 0, '1-3': 0, '4-6': 0, '7-10': 0, 'acima-10': 0,
    };

    const faixaResposta: DistribuicaoFaixa = { ate_2h: 0, de_2h_a_8h: 0, de_8h_a_24h: 0, acima_24h: 0 };

    let datas: Date[] = [];

    for (const ticket of tickets) {
      if (ticket.createdDate) datas.push(new Date(ticket.createdDate));

      // ---- Encerrados ----
      if (ticket.status === 'Resolvido') resolvidos++;
      if (ticket.status === 'Fechado')   fechados++;

      // ---- Falta de informacao ----
      const just = (ticket.justification || '').toLowerCase();
      if (JUSTIFICATIVAS_FALTA_INFO.some(j => just.includes(j))) {
        voltaFaltaInfo++;
        justificativasEncontradas.add(ticket.justification || '');
      }

      const actions: any[] = ticket.actions || [];

      // ---- Tempo de resposta ao cliente: createdDate -> 1a action publica ----
      const primeiraPublica = actions
        .filter(a => a.type === 2 || a.isInternal === false)
        .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];

      const diffResp = diffHoras(ticket.createdDate, primeiraPublica?.createdDate || primeiraPublica?.date);
      if (diffResp !== null && diffResp >= 0) {
        temposResposta.push(diffResp);
        if (diffResp <= 2)         faixaResposta.ate_2h++;
        else if (diffResp <= 8)    faixaResposta.de_2h_a_8h++;
        else if (diffResp <= 24)   faixaResposta.de_8h_a_24h++;
        else                       faixaResposta.acima_24h++;
      }

      // ---- Tempo em "Em atendimento" e "Aguardando Retorno" via actions ----
      // Tentamos inferir periodos de status por meio das mudancas nas actions
      let ultimaData: string | undefined = ticket.createdDate;
      let ultimoStatus: string | undefined = ticket.status;

      for (const action of actions.sort((a, b) =>
        new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime()
      )) {
        const actionDate = action.createdDate || action.date;
        const statusAnterior = action.statusBefore || action.previousStatus;
        const statusNovo = action.status || action.statusAfter;

        if (statusAnterior && statusNovo && ultimaData && actionDate) {
          const diff = diffHoras(ultimaData, actionDate);
          if (diff !== null && diff > 0) {
            if (statusAnterior === STATUS_EM_ATENDIMENTO) {
              temposEmAtendimento.push(diff);
            }
            if (
              statusAnterior === STATUS_AGUARDANDO &&
              ['retorno', 'return'].some(k => (action.justification || just).toLowerCase().includes(k))
            ) {
              temposAguardandoRetorno.push(diff);
            }
            if (statusAnterior === STATUS_ANALISE) {
              temposAnalise.push(diff);
            }
          }
        }
        if (actionDate) ultimaData = actionDate;
        if (statusNovo) ultimoStatus = statusNovo;
      }

      // ---- Tempo de triagem: createdDate -> primeiro status "Analise Projetos" ----
      const actionAnalise = actions
        .filter(a => (a.status || a.statusAfter || '').toLowerCase().includes('analise'))
        .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];

      const diffTriagem = diffHoras(ticket.createdDate, actionAnalise?.createdDate || actionAnalise?.date);
      if (diffTriagem !== null && diffTriagem >= 0) temposTriagem.push(diffTriagem);

      // ---- Tempo para retorno com direcionamento ----
      // Primeira action publica APOS uma action de analise
      if (actionAnalise) {
        const dataAnalise = actionAnalise.createdDate || actionAnalise.date;
        const retornoPos = actions
          .filter(a => {
            const d = a.createdDate || a.date;
            return (a.type === 2 || a.isInternal === false) && d && new Date(d) > new Date(dataAnalise);
          })
          .sort((a, b) => new Date(a.createdDate || a.date || 0).getTime() - new Date(b.createdDate || b.date || 0).getTime())[0];

        const diffDir = diffHoras(ticket.createdDate, retornoPos?.createdDate || retornoPos?.date);
        if (diffDir !== null && diffDir >= 0) temposDirecionamento.push(diffDir);
      }

      // ---- Interacoes com cliente: actions publicas ----
      const publicActions = actions.filter(a => a.type === 2 || a.isInternal === false);
      const count = publicActions.length;
      interacoesPorTicket.push({ id: ticket.id, count });

      if (count === 0)       distribuicaoInteracoes['0']++;
      else if (count <= 3)   distribuicaoInteracoes['1-3']++;
      else if (count <= 6)   distribuicaoInteracoes['4-6']++;
      else if (count <= 10)  distribuicaoInteracoes['7-10']++;
      else                   distribuicaoInteracoes['acima-10']++;
    }

    // Ticket com mais interacoes
    const maxInteracao = interacoesPorTicket.sort((a, b) => b.count - a.count)[0];
    const mediaInteracoes = interacoesPorTicket.length > 0
      ? Math.round((interacoesPorTicket.reduce((s, t) => s + t.count, 0) / interacoesPorTicket.length) * 100) / 100
      : 0;

    const statsResp = statsDeArray(temposResposta);
    const totalEncerrados = resolvidos + fechados;

    // Periodo coberto
    datas.sort((a, b) => a.getTime() - b.getTime());
    const periodo = {
      mais_antigo: datas.length > 0 ? datas[0].toISOString() : null,
      mais_recente: datas.length > 0 ? datas[datas.length - 1].toISOString() : null,
    };

    console.error(`METRICS: Concluido. Tempos de resposta: ${temposResposta.length} amostras.`);

    return {
      gerado_em: new Date().toISOString(),
      total_tickets: tickets.length,
      periodo,
      tempo_resposta_cliente: { ...statsResp, distribuicao_por_faixa: faixaResposta },
      tempo_em_atendimento: statsDeArray(temposEmAtendimento),
      tempo_aguardando_retorno_cliente: statsDeArray(temposAguardandoRetorno),
      tempo_triagem_ate_analise_projetos: statsDeArray(temposTriagem),
      percentual_volta_falta_info: {
        quantidade: voltaFaltaInfo,
        percentual: tickets.length > 0 ? Math.round((voltaFaltaInfo / tickets.length) * 10000) / 100 : 0,
        justificativas_encontradas: Array.from(justificativasEncontradas),
      },
      tempo_em_analise_projetos: statsDeArray(temposAnalise),
      tempo_retorno_com_direcionamento: statsDeArray(temposDirecionamento),
      interacoes_com_cliente: {
        media_por_ticket: mediaInteracoes,
        maximo: maxInteracao?.count || 0,
        ticket_mais_interacoes: maxInteracao?.id || null,
        distribuicao: distribuicaoInteracoes,
      },
      tickets_encerrados: {
        resolvidos,
        fechados,
        total_encerrados: totalEncerrados,
        percentual_sobre_total: tickets.length > 0 ? Math.round((totalEncerrados / tickets.length) * 10000) / 100 : 0,
      },
    };
  }

  async createInternalNote(params: CreateNoteParams): Promise<boolean> {
    try {
      console.error(`Criando nota INTERNA no ticket ${params.ticketId}`);
      const action = { id: 0, type: 1, description: params.description, isInternal: true };
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
