# A disposable "remote server" for multi-server tests: Docker-in-Docker + SSH.
FROM docker:dind
RUN apk add --no-cache openssh bash curl \
 && ssh-keygen -A \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh \
 && passwd -u root 2>/dev/null || true
COPY entrypoint.sh /usr/local/bin/remote-entrypoint.sh
RUN chmod +x /usr/local/bin/remote-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/remote-entrypoint.sh"]
