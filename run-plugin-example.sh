#!/usr/bin/env bash
local_data_dir=${1-"/var/lib/docker/plugins/local-dir/data"}
driver_alias=${2-"local-dir"}

docker run -d --name local-dir-plugin \
-v ${local_data_dir}:/mnt/source-data:rshared \
-v /run/docker/plugins/local-dir:/run/docker/plugins \
--cap-add SYS_ADMIN \
-e ALIAS=${driver_alias} \
-e LOCAL_PATH=${local_data_dir} \
-e ROOT_VOLUME_NAME=docker-volumes \
-e LOG_LEVEL=debug  \
kadimasolutions/plugin_local-dir
