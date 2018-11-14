FROM node:8-slim

####
# Install Docker volume driver API server
####

# Create directories for mounts
RUN mkdir -p /mnt/source-data
RUN mkdir -p /mnt/docker-volumes

# Copy in package.json
COPY package.json package-lock.json /project/

# Switch to the project directory
WORKDIR /project

# Install project dependencies
RUN npm install

# Set Configuration Defaults
ENV ALIAS=local-dir \
    ROOT_VOLUME_NAME="" \
    LOCAL_PATH="" \
    MOUNT_OPTIONS="" \
    LOG_LEVEL=info

# Copy in source code
COPY index.js /project

# Set the Docker entrypoint
ENTRYPOINT ["node", "index.js"]
