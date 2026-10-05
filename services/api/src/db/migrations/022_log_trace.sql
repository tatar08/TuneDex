-- W3C trace id on operational log lines (Doc 17 log schema: requestId/traceId), so staff can follow one
-- trace from the console BFF through the API. Lines written before this migration have none.
ALTER TABLE operational_logs ADD COLUMN trace_id text;
CREATE INDEX operational_logs_trace ON operational_logs (trace_id) WHERE trace_id IS NOT NULL;
