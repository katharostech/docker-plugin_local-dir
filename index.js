//
// Imports
//
const fs = require('fs-extra')
const ls = require('ls')
const path = require('path')
const { execFileSync } = require('child_process')

const http = require('http')
const terminus = require('@godaddy/terminus')
const express = require('express')

//
// Globals
//

// Used when not running as a Docker plugin to set the driver alias
var plugin_alias = process.env['ALIAS']
if (plugin_alias == undefined || plugin_alias == '') {
  plugin_alias = 'local-dir'
}
// The name of the "root" volume ( if specified )
const root_volume_name = process.env['ROOT_VOLUME_NAME']
// Source dir for data storage. You must mount your storage dir from the host
// to this directory in the container.
const volume_root = '/mnt/source-data'
// Directory to mount volumes to inside the container
const container_volume_path = '/mnt/docker-volumes'
// Address that the webserver will listen on
const bind_address = `/run/docker/plugins/${plugin_alias}.sock`

// The directory that volumes are mounted to on the host system
var host_volume_path = process.env['LOCAL_PATH']

// If the `host_volume_basedir` is not set by the user, assume that API server
// running as a Docker plugin and that the host volume path is handled by Docker
// under the propagated mount: /mnt/docker-volumes.
if (host_volume_path == undefined || host_volume_path == '') {
  host_volume_path = container_volume_path
}

// Options to the `mount -b` command
var mount_options = []
if (process.env['MOUNT_OPTIONS'].length != 0) {
  mount_options = process.env['MOUNT_OPTIONS'].split(' ')
}

/*
* Used to keep track of which volumes are in use by containers. For example:
* {
*   "volume_name": [
*     "mount_id1",
*     "mount_id2"
*   ]
* }
*/
var mounted_volumes = {}

// Records whether or not we have mounted the volume root
var has_mounted_volume_root = false

//
// Logging
//

const log = require('loglevel-message-prefix')(require('loglevel'), {
  prefixes: ['level'],
})

// Log level set by plugin config
log.setLevel(process.env['LOG_LEVEL'])

log.info('Starting up local-dir volume plugin')

//
// Express webserver and middleware
//

var app = express()
// JSON body parser
app.use(express.json({type: () => true}))

// Plugin activation
app.use(function (req, res, next) {
  // If this is an activation request
  if (req.method == 'POST' && req.path == '/Plugin.Activate') {
    log.debug('/Plugin.Activate')
    res.json({
      Implements: ['VolumeDriver']
    })
    return
  } else {
    next()
  }
})

//
// Helper Functions
//

/*
 * Determine whether or not a volume is mounted by a container based on our
 * `mounted_volumes` object.
 */
function volume_is_mounted(volume_name) {
  if (mounted_volumes[volume_name] != undefined &&
      mounted_volumes[volume_name].length != 0) {
    return true
  } else {
    return false
  }
}

//
// Implement the Docker volume plugin API
//

app.post('/VolumeDriver.Create', function (req, res) {
  var volume_name = req.body.Name
  var volume_path = path.join(volume_root, volume_name)

  log.info(`/VolumeDriver.Create: ${volume_name}`)

  if (volume_name == root_volume_name) {
    // You cannot create a volume with the same name as the root volume.
    log.warn("Tried to create a volume with same name as root volume. Ignoring request.")

    // Return without doing anything.
    res.json({})
    return
  }

  try {
    // Create volume on filesystem
    fs.ensureDirSync(volume_path)

    // Success
    res.json({})
    return

  } catch (err) {
    // Failure
    res.json({
      Err: err.toString()
    })
    return
  }
})

app.post('/VolumeDriver.Remove', function (req, res) {
  var volume_name = req.body.Name
  var volume_path = path.join(volume_root, volume_name)

  log.info(`/VolumeDriver.Remove: ${volume_name}`)

  if (volume_name == root_volume_name) {
    // You cannot delete the root volume.
    // Return an error.
    res.json({
      Err: 'You cannot delete the root volume.'
    })
    return
  }

  try{
    // Remove volume on LizardFS filesystem
    fs.removeSync(volume_path)

    // Success
    res.json({})
    return

  } catch (err) {
    // Failure
    res.json({
      Err: err.toString()
    })
    return
  }

})

app.post('/VolumeDriver.Mount', function (req, res) {
  var volume_name = req.body.Name
  var mount_id = req.body.ID
  var container_mountpoint = path.join(container_volume_path, volume_name)
  var host_mountpoint = "";

  if (volume_name == root_volume_name) {
    // Mount *all* of the volumes
    host_mountpoint = host_volume_path
  } else {
    host_mountpoint = path.join(host_volume_path, volume_name)
  }

  log.debug(`/VolumeDriver.Mount: ${volume_name}`)
  log.debug(`           Mount ID: ${mount_id}`)

  // If the volume is already mounted
  if (volume_is_mounted(volume_name)) {
    // Add the container to the list of containers that have mounted this volume
    mounted_volumes[volume_name].push(mount_id)

    // Return the mountpoint
    res.json({
      Mountpoint: host_mountpoint
    })
    return

  // If the volume has not been mounted yet
  } else {
    try {
      // Create volume mountpoint
      log.debug(`Creating mountpoint: ${container_mountpoint}`)
      fs.ensureDirSync(container_mountpoint)

      var mount_source_path = ""
      // If we are mounting the root volume
      if (volume_name == root_volume_name) {
        // We mount the directory containing *all* of the volumes
        mount_source_path = volume_root
      } else {
        // We mount the specified volume
        mount_source_path = path.join(volume_root, volume_name)
      }

      log.debug(`mount_source_path: ${mount_source_path}`)

      // Unmount the volume if it was already mounted
      // try {
      //   execFileSync('umount', [container_mountpoint]);
      // } catch (err) {} // We don't care if it isn't mounted

      // Mount volume
      // execFileSync(
      //   'mount',
      //   [
      //     '-o', 'bind',
      //     ...mount_options,
      //     mount_source_path,
      //     container_mountpoint
      //   ],
      //   {
      //     // We only wait 3 seconds for the master to connect.
      //     // This prevents the plugin from stalling Docker operations if the
      //     // LizardFS master is unresponsive.
      //     timeout: parseInt(process.env['CONNECT_TIMEOUT'])
      //   }
      // )

      // Start a list of containers that have mounted this volume
      mounted_volumes[volume_name] = [mount_id]

      // Success: Return the mountpoint
      res.json({
        Mountpoint: host_mountpoint
      })
      return

    } catch (err) {
      // Failure
      res.json({
        Err: err.toString()
      })
      return
    }
  }
})

app.post('/VolumeDriver.Path', function (req, res) {
  var volume_name = req.body.Name
  var host_mountpoint = path.join(host_volume_path, volume_name)

  log.debug(`/VolumeDriver.Path: ${volume_name}`)

  // If the volume is mounted
  if (volume_is_mounted(volume_name)) {
    // Return the Mountpoint
    res.json({
      Mountpoint: host_mountpoint
    })
    return

  } else {
    // Nothing to return
    res.json({})
    return
  }
})

app.post('/VolumeDriver.Unmount', function (req, res) {
  var volume_name = req.body.Name
  var mount_id = req.body.ID
  var container_mountpoint = path.join(container_volume_path, volume_name)

  log.debug(`/VolumeDriver.Unmount: ${volume_name}`)

  // Remove this from the list of mounted volumes
  mounted_volumes[volume_name].pop(mount_id)

  // If there are no longer any containers that are mounting this volume
  if (mounted_volumes[volume_name].length == 0) {
    try {
      // Unmount the volume
      execFileSync('umount', [container_mountpoint])

      // Success
      res.json({})
      return

    } catch (err) {
      // Failure
      res.json({
        Err: err.toString()
      })
      return
    }

  } else {
    // Success
    res.json({})
    return
  }
})

app.post('/VolumeDriver.Get', function (req, res) {
  var volume_name = req.body.Name
  var host_mountpoint = path.join(host_volume_path, volume_name)

  log.debug(`/VolumeDriver.Get: ${volume_name}`)

  // If the volume is the root volume
  if (volume_name == root_volume_name) {
    // If the root volume is mounted
    if (volume_is_mounted(root_volume_name)) {
      // Return the volume name and the mountpoint
      res.json({
        Volume: {
          Name: root_volume_name,
          Mountpoint: host_mountpoint
        }
      })
      return

    // If the root volume is not mounted
    } else {
      // Return the volume name
      res.json({
        Volume: {
          Name: root_volume_name
        }
      })
      return
    }
  }

  try {
    // Check directory access on LizardFS directory
    fs.accessSync(path.join(volume_root, req.body.Name),
      fs.constants.R_OK | fs.constants.W_OK)

    log.debug(`Found Volume: ${volume_name}`)

    // If the volume is mounted
    if (volume_is_mounted(volume_name)) {
      // Return volume name and mountpoint
      res.json({
        Volume: {
          Name: volume_name,
          Mountpoint: host_mountpoint
        }
      })
      return

    // If volume is not mounted
    } else {
      // Return volume name
      res.json({
        Volume: {
          Name: volume_name
        }
      })
      return
    }

  } catch (err) {
    // Failure
    log.warn(`Cannot Access Volume: ${volume_name}`)

    res.json({
      Err: err.toString()
    })
    return
  }
})

app.post('/VolumeDriver.List', function (req, res) {
  var volumes = []

  log.debug('/VolumeDriver.List')

  // If the root volume name has been specified
  if (root_volume_name != "") {
    // If the root volume has been mounted
    if (volume_is_mounted(root_volume_name)) {
      // Add the volume name and mountpoint
      volumes.push({
        Name: root_volume_name,
        Mountpoint: path.join(host_volume_path, root_volume_name)
      })

    // If the root volume has not been mounted
    } else {
      // Add the volume name
      volumes.push({
        Name: root_volume_name
      })
    }
  }

  // For every file or folder in the volume root directory
  for (var file of ls(volume_root + "/*")) {
    // If it is a directory
    if (file.stat.isDirectory()) {
      // If the directory has the same name as the root volume
      if (file.name == root_volume_name) {
        // Skip this volume, the root volume takes precedence
        log.warn('Found volume with same name as root volume: ' +
          `'${root_volume_name}' Skipping volume, root volume takes precedence.`)
        continue
      }

      // If the volume is mounted
      if (volume_is_mounted(file.name)) {
        // Add the volume name and mountpoint
        volumes.push({
          Name: file.name,
          Mountpoint: path.join(host_volume_path, file.name)
        })

      // If the volume is not mounted
      } else {
        // Add the volume name
        volumes.push({
          Name: file.name
        })
      }
    }
  }

  // Return the volume list
  res.json({
    Volumes: volumes
  })
  return
})

app.post('/VolumeDriver.Capabilities', function (req, res) {
  log.debug('/VolumeDriver.Capabilities')
  res.json({
    Capabilities: {
      Scope: 'global'
    }
  })
  return
})

//
// Shutdown sequence
//

function onSignal() {
  log.info('Termination signal detected, shutting down')

  // For each volume
  for (volume_name in mounted_volumes) {
    // If the volume is mounted
    if (volume_is_mounted(volume_name)) {
      try {
        log.debug(`Unmounting volume: ${volume_name}`)

        // Unmount the volume
        execFileSync('umount', [path.join(container_volume_path, volume_name)])

      } catch (err) {
        // Failure
        log.warn(`Couldn't unmount volume: ${volume_name}: ${err.toString()}`)
      }
    }
  }

  // Unmount volume root
  if (has_mounted_volume_root) {
    try {
      log.debug(`Unmounting volume root: ${volume_root}`)

      // Unmount volume root
      execFileSync('umount', [volume_root])

    } catch (err) {
      // Failure
      log.warn(`Couldn't unmount volume root '${volume_root}': ${err.toString()}`)
    }
  }
}

//
// Start Server
//

log.info(`Starting plugin API server at ${bind_address}`)

// Start webserver using terminus for lifecycle management
terminus(http.createServer(app), {
  logger: log.error,
  onSignal,
  onShutdown: () => {
    log.info("Server shutdown complete")
  }
}).listen(bind_address)
