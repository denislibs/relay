-- Звонки: два новых правила конфиденциальности — «Кто может мне звонить» (calls) и прямые соединения (p2p).
alter table privacy_rules drop constraint if exists privacy_rules_key_check;
alter table privacy_rules add constraint privacy_rules_key_check
  check (key in ('phone', 'phoneDiscovery', 'lastSeen', 'bio', 'birthday', 'calls', 'p2p'));
