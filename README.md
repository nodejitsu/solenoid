# solenoid

Jump start an application. `solenoid` is a binary script that does the following:

* _Start an app:_ `solenoid start -p PIDFILE -u USERNAME -a APP_NAME -v APP_VERSION`
* _Stop an app:_ `solenoid stop -p PIDFILE`
* _Restart an app:_ `solenoid restart -p PIDFILE`

### Solenoid Start logic

When `solenoid` starts an application it performs the following operation:

1. Creates the run direction `options.runDir`
2. Creates the `solenoid` user
3. Fetches the application snapshot to `RUN_DIR/snapshot.tgz`
4. Unpacks the snapshot to `RUN_DIR/snapshot/package`
5. Removes the packed snapshot at `RUN_DIR/snapshot.tgz`
6. Reads the `package.json` at `RUN_DIR/snapshot/package/package.json`
7. Determines the `node` engine. _Defaults to `options.engines.node.default || 0.6.x`._
8. Reads the ENVVARS from `-e|--app-env` _(if any)_.
9. Restricts the filesystem to the `solenoid` user
10. Gets the `uid` and `gid` of the `solenoid` user
11. Starts the application using `aeternum` and `forza`.

### CLI Arguments

```
  -u, --app-user     Username of the owner of the application.
  -a, --app-name     Name of the application.
  -v, --app-version  Version of the application.
  -e, --app-env      Environment vars as serialized JSON. 
  -p, --pidfile      Location of the pidfile on disk of the aeternum process.
```

### Configuration

`solenoid` expects a configuration file `$HOME/.solenoidconf` with the following options:

``` js
{
  "storage": {
    //
    // Valid pkgcloud storage provider configuration
    //
    "provider":  "rackspace",
    "username":  "rackspace-username",
    "apiKey":    "rackspace-apiKey",
    "container": "rackspace-container",
    "region":    "ord"
  },
  "instruments": [
    //
    // Instruments provider to send metrics and events to.
    //
    {
      "host": "127.0.0.1",
      "port": 8556
    }
  ],
  //
  // Directory to run applications within.
  //
  "runDir": "/opt/run"
  "engines": {
    "node": {
      "default": "0.6.x",
      "path": "/opt/engines/node"
    }
  }
}
```

#### Copyright (C) Nodejitsu 2013
