-- Ключ устройства — с самого входа (deviceAuth.ts: deviceProof): сеанс создаётся уже привязанным.
-- Паскей: ключ устройства записан при выдаче вызова — подпись паскея над этим вызовом впускает именно его.
-- QR: ключ нового устройства записан при создании кода — забрать вход опросом может только оно (подпись этим ключом).
alter table webauthn_challenges add column if not exists device_key bytea;
alter table qr_logins add column if not exists device_key bytea;
