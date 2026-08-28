FROM nginx:1.27-alpine
RUN apk add --no-cache gettext # envsubst
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY conf.d/app.conf.template /etc/nginx/conf.d/app.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
