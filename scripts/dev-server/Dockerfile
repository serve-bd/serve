# A local "VPS" for trying multiple servers: plain Ubuntu 24.04 with SSH and a sudo user,
# like a fresh cloud server. Docker is not installed; add the server in the dashboard and use
# "Install Docker" to set it up the way a real server would be.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo curl ca-certificates iptables iproute2 procps kmod gnupg lsb-release \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu \
 && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
 && install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh \
 && touch /home/ubuntu/.ssh/authorized_keys && chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys && chmod 600 /home/ubuntu/.ssh/authorized_keys
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 22 80 443
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
