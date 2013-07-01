var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    spawn = require('child_process').spawn,
    async = require('async'),
    pkgcloud = require('pkgcloud'),
    useradd = require('useradd');

var snapshotPath = path.join(os.tmpDir(), 'snapshot.tgz');

//
// Starts an application.
//
module.exports = function (options, callback) {
  async.parallel([
    async.apply(fetch, options),
    async.apply(createUser, options)
  ], function (err) {
    if (err) {
      return callback(err);
    }

    async.series([
      async.apply(unpack, options),
      async.apply(start, options)
    ], callback);
  });
};

module.exports.fetch = function fetch(options, callback) {
  var client = pkgcloud.storage.createClient(options.storage),
      tries = 0,
      maxTries = 5;

  function doFetch(callback) {
    ++tries;

    client.download({
      container: options.storage.container,
      remote: [ options.app.user, options.app.name, options.app.version ].join('-') + '.tgz'
    })
      .pipe(fs.createWriteStream(snapshotPath))
      .on('error', function (err) {
        console.error('Error while fetching snapshot: ' + err.message);
        return tries === maxTries
          ? callback(err)
          : doFetch(callback);
      });
  }

  console.log('Fetching application snapshot...');

  doFetch(callback);
};

//
// Create a dedicated user account.
//
module.exports.createUser = function createUser(options, callback) {
  console.log('Creating user...');

  useradd({
    login: 'nodejitsu-' + options.app.user,
    shell: false,
    home: false
  }, callback);
};

module.exports.unpack = function unpack(options, callback) {
  console.log('Unpacking snapshot...');

  var child = spawn('tar', ['-xf', snapshotPath], {
    cwd: 
  });

  child.on('exit', function (code, signal) {
    if (code !== 0) {
      return callback(new Error('`tar` exited with code ' + code.toString()));
    }

    return callback();
  });
};
