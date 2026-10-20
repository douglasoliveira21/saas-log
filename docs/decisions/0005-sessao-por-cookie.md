# ADR-0005 — Sessão por cookies httpOnly e proxy same-origin
Access JWT curto + refresh opaco rotativo em cookies httpOnly; o Next faz proxy de `/api` para evitar CORS e expor tokens ao JavaScript. CSRF mitigado por SameSite=Lax + cabeçalho `x-dh-csrf`. Permissões nunca vêm do token: são lidas do banco a cada requisição.
