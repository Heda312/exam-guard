proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
# Overwrite, never append: with real_ip configured, $remote_addr is the true
# client IP. Appending would let a spoofed client-supplied chain through.
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_read_timeout 120s;
proxy_connect_timeout 10s;
