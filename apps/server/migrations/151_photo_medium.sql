-- копия фото medium (jobs/photo.ts): WebP, длинная сторона до 800 px — пузырь в ленте грузит её, а не оригинал
alter table attachment_variants drop constraint if exists attachment_variants_name_check;
alter table attachment_variants add constraint attachment_variants_name_check check (name in ('preview', '720', 'medium'));
