import { counter, gauge, histogram } from './metrics';

// Каталог метрик Relay (docs/observability.md, «Метрики»): объявлены в одном месте, чтобы имена и метки
// не разъезжались между модулями и панелями Grafana (deploy/observability/grafana).

// ---- HTTP (server) ----
export const httpRequests = counter('relay_http_requests_total', 'HTTP-запросы по группе маршрута, методу и статусу');
export const httpDuration = histogram('relay_http_request_duration_seconds', 'Время ответа HTTP по группе маршрута');

// ---- WebSocket (server) ----
export const wsConnections = gauge('relay_ws_connections', 'Открытые допущенные WebSocket-соединения процесса');
export const wsFrames = counter('relay_ws_frames_total', 'Кадры клиента по op и исходу (ok или код ошибки; flood — сверх лимита)');
export const wsCloses = counter('relay_ws_closes_total', 'Закрытия сокета сервером по причине');

// ---- задачи (worker) ----
export const jobsProcessed = counter('relay_jobs_processed_total', 'Выполненные задачи по kind и исходу (ok | retry | dead)');
export const jobDuration = histogram('relay_job_duration_seconds', 'Время выполнения задачи по kind', [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 1800]);
export const jobsReady = gauge('relay_jobs_ready', 'Готовых к выполнению задач в очереди по kind');
export const jobsLag = gauge('relay_jobs_lag_seconds', 'Сколько ждёт самая старая готовая задача kind');
export const jobsDead = gauge('relay_jobs_dead', 'Задач в jobs_dead за последние 24 часа по kind');

// ---- звонки ----
export const callRequests = counter('relay_call_requests_total', 'Попытки начать звонок 1:1 по исходу (ok | unavailable | in_call | busy | flood)');
export const callEnds = counter('relay_call_ends_total', 'Завершённые звонки 1:1 по причине (ended | missed | declined | failed …)');
export const callPaths = counter('relay_call_paths_total', 'Соединения звонков по данным клиентов: kind (p2p | group), path (direct | relay)');
export const groupCallJoins = counter('relay_group_call_joins_total', 'Входы в групповой звонок по исходу (ok или код ошибки)');
export const liveKitErrors = counter('relay_livekit_errors_total', 'Ошибки серверного API LiveKit по методу и причине');

// ---- коды входа (worker) ----
export const codeDeliveries = counter('relay_code_deliveries_total', 'Доставка кодов внешним каналом: channel, result (ok | failed | capped | expired)');

// ---- клиент ----
export const clientErrors = counter('relay_client_errors_total', 'Ошибки клиентов по источнику и сборке клиента');
export const clientReportsDropped = counter('relay_client_reports_dropped_total', 'Отклонённые отчёты клиентов по причине (rate | size | bad)');

// ---- готовность ----
export const dependencyUp = gauge('relay_dependency_up', 'Зависимость доступна (1) или нет (0): postgres, valkey, kms');
