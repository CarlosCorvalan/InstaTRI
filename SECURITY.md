# Security Policy / Política de seguridad

## Reporting a vulnerability / Reportar una vulnerabilidad

If you find a security issue in this project, please **do not open a public issue**.
Use GitHub's private vulnerability reporting: **Security tab → "Report a vulnerability"**.
Do not include credentials, personal data or production data in your report.

Si encontrás un problema de seguridad, **no abras un issue público**.
Usá el reporte privado de GitHub: pestaña **Security → "Report a vulnerability"**.
No incluyas credenciales, datos personales ni datos de producción en el reporte.

## Scope / Alcance

Static web front-end (HTML/JS). The backend (Supabase) is protected with row-level
security; write access requires authentication. This repository must not contain secrets,
API secret keys, `.env` files or trial datasets. Only the Supabase project URL and the
publishable (anon) key, which are client-side by design, may appear in the code.

Front-end web estático (HTML/JS). El backend (Supabase) usa seguridad por filas (RLS) y la
escritura requiere autenticación. Este repositorio no debe contener secretos, claves
secretas, archivos `.env` ni datos de ensayos. Solo pueden figurar la URL del proyecto de
Supabase y la clave publicable (anon), que es pública por diseño.
