/*
This file contains the IPFS Boards API. It's a simple abstraction over the
js-ipfs-api that also provides an additional level of caching for this
particular application. Let's hope it turns out decent

Needs to be browserified to work in the browser
*/

// EventEmitter used to communicate with clients
var EventEmitter = require('wolfy87-eventemitter')
var asyncjs = require('async')
var semver = require('semver')
var wreck = require('wreck')

function asObj (str, done) {
  if (str.toString) str = str.toString()
  if (typeof str === 'string') {
    var obj
    try {
      obj = JSON.parse(str)
    } catch (e) {
      console.log('error parsing:', str, 'Error:', e)
      return done(e, undefined)
    }
    done(null, obj)
  } else {
    console.log('not string:', str)
    done('not string: ' + str, undefined)
  }
}

function replyAsObj (res, isJson, done) {
  if (res.readable) {
    // Is a stream
    console.log('got stream')
    res.setEncoding('utf8')
    var data = ''
    res.on('data', d => {
      console.log('got stream data:', d)
      data += d
    })
    res.on('end', () => {
      if (isJson) {
        asObj(data, done)
      } else {
        done(null, data)
      }
    })
  } else if (res.split || res.toString) {
    // console.log('got string or buffer:',res)
    if (res.toString) res = res.toString()
    // Is a string
    if (isJson) {
      asObj(res, done)
    } else {
      done(null, res)
    }
  }
}

function BoardsAPI (ipfs) {
  this.ipfs = ipfs
  this.version = 'ipfs:boards:version:dev'
  this.baseurl = '/ipfs-boards-profile/'
  this.users = [] // list of IPNS names
  this.resolvingIPNS = {}
  this.ee = new EventEmitter()
  if (window && window.localStorage !== undefined) {
    this.ee.on('init', e => {
      if (e) {
        console.log('init failed')
        this.init_error = e
      }
    })
    // Use localStorage to store the IPNS cache
    var stored = window.localStorage.getItem('ipfs-boards-user-cache')
    try {
      this.users = JSON.parse(stored)
      if (this.users === null || this.users === undefined || !this.users.indexOf || !this.users.push) {
        this.users = []
      }
    } catch (e) {
      this.users = []
    }
  }
}

BoardsAPI.prototype.restoreProfileFromMFS = function (done) {
  this.ipfs.files.stat('/ipfs-boards-profile', (err, r) => {
    if (err) return done(err)
    this.ipfs.files.stat('/', (err, res) => {
      if (err) return done(err)
      this.ipfs.name.publish(res.Hash, done)
    })
  })
}

BoardsAPI.prototype.restoreProfileFromIPFS = function (hash, done) {
  // TODO: cp it into mfs or this won't work
  this.ipfs.name.publish(hash, done)
}

BoardsAPI.prototype.createProfile = function (profile, done) {
  console.log('Generating profile:', profile)
  try {
    var profileStr = JSON.stringify(profile)
  } catch (e) {
    console.log('Error, invalid profile:', e)
    return done(e)
  }
  asyncjs.waterfall([
    // Create required directories
    cb => this.ipfs.files.mkdir('/ipfs-boards-profile/boards', { p: true }, cb),
    (e, cb) => this.ipfs.files.mkdir('/ipfs-boards-profile/comments', { p: true }, cb),
    (e, cb) => this.ipfs.files.mkdir('/ipfs-boards-profile/posts', { p: true }, cb),
    (e, cb) => {
      // Remove old profile files if present
      var path = '/ipfs-boards-profile/ipfs-boards-version.txt'
      this.ipfs.files.rm(path, { recursive: true }, res => {
        var path = '/ipfs-boards-profile/profile.json'
        this.ipfs.files.rm(path, { recursive: true }, res => cb())
      })
    },
    cb => {
      // Add profile version file
      var path = '/ipfs-boards-profile/ipfs-boards-version.txt'
      var versionHash = '/ipfs/' + this.versionHash
      this.ipfs.files.cp([versionHash, path], cb)
    },
    (e, cb) => {
      // Serialize profile and add to IPFS
      var file = {
        path: 'profile.json',
        content: profileStr
      }
      this.ipfs.add(file, cb)
    },
    (res, cb) => {
      // Move profile into mfs
      var hash = res[0].Hash
      console.log('added profile to IPFS:', hash)
      var profilepath = '/ipfs/' + hash
      this.ipfs.files.cp([profilepath, '/ipfs-boards-profile/profile.json'], cb)
    },
    (e, cb) => this.ipfs.files.stat('/', cb),
    (res, cb) => {
      console.log('Result:', res)
      var profileHash = res.Hash
      console.log('Publishing profile...')
      this.ipfs.name.publish(profileHash, cb)
    }
  ], done)
}

BoardsAPI.prototype.createBoard = function (board, done) {
  console.log('Generating board:', board)
  try {
    var settingsStr = JSON.stringify(board)
  } catch (e) {
    console.log('Error, invalid Board Settings:', e)
    return done(e)
  }
  var dest = '/ipfs-boards-profile/boards/' + board.id + '/settings.json'
  asyncjs.waterfall([
    // Create required directories
    cb => this.ipfs.files.mkdir('/ipfs-boards-profile/boards/' + board.id + '/', { p: true }, cb),
    (e, cb) => {
      // Remove old board files if present
      this.ipfs.files.rm(dest, { r: true }, res => cb())
    },
    (cb) => {
      // Serialize Board Settings and add to IPFS
      // TODO: fix usage of ipfs.add
      var file = {
        path: 'settings.json',
        content: settingsStr
      }
      this.ipfs.add(file, cb)
    },
    (res, cb) => {
      // Move Board into mfs
      var hash = res[0].Hash
      console.log('added Board Settings to IPFS:', hash)
      var spath = '/ipfs/' + hash
      this.ipfs.files.cp([spath, dest], cb)
    },
    (e, cb) => this.ipfs.files.stat('/', cb),
    (res, cb) => {
      var profileHash = res.Hash
      console.log('Publishing profile...')
      this.ipfs.name.publish(profileHash, cb)
    }
  ], done)
}

BoardsAPI.prototype.createPost = function (post, board, done) {
  try {
    post.date = parseInt((new Date()).getTime() / 1000, 10)
    post.op = this.id
    var postStr = JSON.stringify(post)
  } catch (e) {
    console.log('Error, invalid Post:', e)
    return done(e)
  }
  if (!post.text) return done('empty post')
  console.log('Posting:', post)
  var dest = '/ipfs-boards-profile/posts/' + board + '/' + post.date + '.json'
  var posthash
  asyncjs.waterfall([
    // Create required directories
    cb => this.ipfs.files.mkdir('/ipfs-boards-profile/posts/' + board + '/', { p: true }, cb),
    (e, cb) => {
      // Remove old post file if present
      this.ipfs.files.rm(dest, { r: true }, res => cb())
    },
    (cb) => {
      if (post.previous) {
        // Remove previous post from post list in profile
        // First fetch the previous post
        this.cat(post.previous, (err, res) => {
          if (err) {
            console.log('Previous post unreachable')
            done()
          }
          try {
            var prevPost = JSON.parse(res)
          } catch (e) {
            console.log('Previous post is not valid:', e)
            cb()
          }
          var prevPostDest = '/ipfs-boards-profile/posts/' + board + '/' + prevPost.date + '.json'
          this.ipfs.files.rm(prevPostDest, err => {
            if (err) console.log('Previous post could not be deleted:', err, prevPostDest)
            cb()
          })
        })
      } else cb()
    },
    (cb) => {
      // Serialize post and add to IPFS
      var file = {
        path: 'post.json',
        content: postStr
      }
      this.ipfs.add(file, cb)
    },
    (res, cb) => {
      // Move post into mfs
      var hash = res[0].Hash
      console.log('added Post to IPFS:', hash)
      posthash = hash
      var spath = '/ipfs/' + hash
      this.ipfs.files.cp([spath, dest], cb)
    },
    (e, cb) => this.ipfs.files.stat('/', cb),
    (res, cb) => {
      var profileHash = res.Hash
      console.log('Publishing profile...')
      this.ipfs.name.publish(profileHash, err => {
        done(err, posthash)
      })
    }
  ], done)
}
BoardsAPI.prototype.createComment = function (comment, parent, done) {
  try {
    comment.date = parseInt((new Date()).getTime() / 1000, 10)
    comment.op = this.id
    comment.parent = parent
    var commentStr = JSON.stringify(comment)
  } catch (e) {
    console.log('Error, invalid Post:', e)
    return done(e)
  }
  if (!comment.text) return done('empty comment')
  console.log('Commenting:', comment)
  var dest = '/ipfs-boards-profile/comments/' + parent + '/' + comment.date + '.json'
  var commenthash
  asyncjs.waterfall([
    // Create required directories
    cb => this.ipfs.files.mkdir('/ipfs-boards-profile/comments/' + parent + '/', { p: true }, cb),
    (e, cb) => {
      // Remove old comment file if present
      this.ipfs.files.rm(dest, { r: true }, res => cb())
    },
    (cb) => {
      // Serialize comment and add to IPFS
      var file = {
        path: 'comment.json',
        content: commentStr
      }
      this.ipfs.add(commentStr, cb)
    },
    (res, cb) => {
      // Move post into mfs
      var hash = res[0].Hash
      console.log('added Comment to IPFS:', hash)
      commenthash = hash
      var spath = '/ipfs/' + hash
      this.ipfs.files.cp([spath, dest], cb)
    },
    (e, cb) => this.ipfs.files.stat('/', cb),
    (res, cb) => {
      var profileHash = res.Hash
      console.log('Publishing profile...')
      this.ipfs.name.publish(profileHash, err => {
        done(err, commenthash)
      })
    }
  ], done)
}

BoardsAPI.prototype.delete = function (opts, done) {
  var url = '/ipfs-boards-profile/'
  console.log('Deleting', opts)
  if (opts.what === 'post') url += 'posts/' + opts.board + '/'
  if (opts.what === 'comment') url += 'comments/' + opts.parent + '/'
  if (opts.what === 'comment' || opts.what === 'post') {
    this.ipfs.files.ls(url, (err, res) => {
      if (err) return done(err)
      if (!res || !res.Entries) return done('invalid response')
      var list = res.Entries
      for (var item in list) {
        if (list[item].Hash === opts.hash) {
          url = url + list[item].Name
          this.ipfs.files.cat(url, (err, res) => {
            // Look for previous versions
            if (err || opts.previouses.indexOf(opts.hash) >= 0) return
            replyAsObj(res, true, (err, obj) => {
              if (!err && obj.previous) {
                // Delete if found
                this.delete({
                  what: opts.what,
                  hash: obj.previous,
                  // Check for cyclic depdendency structures
                  previouses: (opts.previouses || []).concat(opts.hash)
                })
              }
            })
          })
          return this.ipfs.files.rm(url, {}, err => {
            if (err) return done(err)
            this.ipfs.files.stat('/', (err, res) => {
              if (err) return done(err)
              console.log('Publishing profile...')
              this.ipfs.name.publish(res.Hash, done)
            })
          })
        }
      }
      return done('post does not exist or was already deleted')
    })
  } else if (opts.what === 'board' || opts.what === 'profile') {
    if (opts.what === 'board') {
      url += 'boards/' + opts.board
    }
    this.ipfs.files.rm(url, { r: true }, err => {
      if (err) return done(err)
      this.ipfs.files.stat('/', (err, res) => {
        if (err) return done(err)
        console.log('Publishing profile...')
        this.ipfs.name.publish(res.Hash, done)
      })
    })
  } else {
    done('what?')
  }
}

BoardsAPI.prototype.deletePost = function (hash, board, done) {
  this.delete({ what: 'post', hash, board }, done)
}

BoardsAPI.prototype.deleteComment = function (hash, parent, done) {
  this.delete({ what: 'comment', hash, parent }, done)
}

BoardsAPI.prototype.cat = function (path, done) {
  if (this.limited) {
    // Download via gateway
    if (path.indexOf('Qm') === 0) {
      path = '/ipfs/' + path
    }
    console.log('Downloading via Gateway: ', path)
    wreck.get(path, (err, res, payload) => {
      console.log('GET:', err, res, payload)
      if (payload.toString) payload = payload.toString()
      done(err, payload)
    })
  } else {
    // Download via http api
    try {
      this.ipfs.cat(path, (err, res) => {
        if (err) return done(err)
        var ret = ''
        res.on('error', e => {
          done(e)
        })
        res.on('data', (data) => {
          ret += data
        })
        res.on('end', () => {
          done(null, ret)
        })
      })
    } catch (e) {
      done(e)
    }
  }
}

BoardsAPI.prototype.ls = function (path, done) {
  if (this.limited) {
    // Download via gateway not yet implemented :(
    done('this operation is not supported in limited mode')
  } else {
    // Download via http api
    try {
      this.ipfs.ls(path, done)
    } catch (e) {
      done(e)
    }
  }
}

BoardsAPI.prototype.backupCache = function () {
  if (window && window.localStorage !== undefined) {
    // Use localStorage to store the IPNS cache
    window.localStorage.setItem('ipfs-boards-user-cache', JSON.stringify(this.users))
  }
}

// Rewrote this to use event emitters. Should also add periodic rechecking
// TODO: maybe drop this entirely? We can cat and ls IPNS names now.
BoardsAPI.prototype.resolveIPNS = function (n, handler) {
  if (handler && handler.apply) this.ee.on(n, handler)
  if (this.limited) {
    // In limited mode, don't solve addresses
    return this.ee.emit(n, '/ipns/' + n)
  }
  if (!this.resolvingIPNS[n]) {
    this.resolvingIPNS[n] = true
    this.ipfs.name.resolve(n, (err, r) => {
      delete this.resolvingIPNS[n]
      if (err) {
        // Communicate error
        this.ee.emit('error', err)
        if (handler && handler.apply) handler(undefined, err)
      } else {
        var url = r.Path
        if (url === undefined) {
          console.log('Could not resolve', n)
          this.ee.emit('error', r.Message)
        } else if (this.users.indexOf(n) < 0) { // new find
          this.isUserProfile(url, (isit, err) => {
            if (isit) {
              console.log(n, 'is a user')
              this.ee.emit(n, url)
              if (this.users.indexOf(n) < 0) {
                this.ee.emit('user', n, url)
                this.users.push(n)
                this.backupCache()
              }
            } else {
              console.log(n, 'not a valid profile:', err)
              this.ee.emit(n, undefined, 'not a valid profile: ' + err)
            }
            return true // Remove from listeners
          })
        } else { // Already known
          this.ee.emit(n, url)
        }
      }
    })
  }
  return this.ee
}

BoardsAPI.prototype.isUserProfile = function (addr, done) {
  if (addr === undefined) return console.log('Asked to check if undefined is a profile')
  this.cat(addr + this.baseurl + 'ipfs-boards-version.txt', (err, r) => {
    if (err) return done(false, err)
    replyAsObj(r, false, (_, res) => {
      if (!res || !res.trim) {
        console.log('Could not read version from', addr)
      } else {
        var v = res.trim()
        console.log('Version in profile snapshot', addr, 'is', v)
        if (v === this.version) {
          done(true)
        } else {
          done(false, 'version mismatch: is "' + v + '" but should be "' + this.version + '"')
        }
      }
    })
  })
}

BoardsAPI.prototype.searchUsers = function () {
  // Look at our peers
  this.ipfs.swarm.peers((err, r) => {
    if (err) return console.log(err)
    replyAsObj(r, true, (e, reply) => {
      if (e) {
        this.ee.emit('error', e)
        return console.log('There was an error while getting swarm peers:', e)
      }
      console.log('Checking', reply.Strings.length, 'peers')
      // reply.Strings.forEach(item => {
      var f = (item, done) => {
        var ss = item.split('/')
        var n = ss[ss.length - 1]
        this.ee.once(n, (res, err) => done(err))
        this.resolveIPNS(n)
      }
      asyncjs.eachSeries(reply.Strings, f.bind(this))
    })
  })
  // Look for who has the correct version file, they probably have a profile
  /*
  this.ipfs.dht.findprovs(this.versionHash, (err,res) => {
    if(err){
      console.log('DHT FINDPROVS err',err)
    } else if(res.readable){
      console.log('DHT FINDPROVS stream',res)
    } else {
      console.log('DHT FINDPROVS string',res)
    }
  })*/
  return this.ee
}

BoardsAPI.prototype.getProfile = function (userID, done) {
  this.resolveIPNS(userID, (url, err) => {
    if (err) {
      this.ee.emit('error', err)
      done(err, null)
    } else {
      // Download actual profile
      this.cat(url + this.baseurl + 'profile.json', (err2, res) => {
        if (err2) {
          this.ee.emit('error', err2)
          done(err2, null)
        } else {
          console.log('Got Profile: ', res)
          var p
          try {
            p = JSON.parse(res.toString())
          } catch (e) {
            this.ee.emit('error', e)
            if (done && done.apply) done(e)
            return
          }
          this.ee.emit('profile for ' + userID, p)
          done(null, p)
        }
      })
      // Get other info
      this.ls(url + this.baseurl + 'boards/', (err2, res) => {
        if (!err2) {
          var l = res.Objects[0].Links.map(i => {
            return { name: i.Name, hash: i.Hash }
          })
          this.ee.emit('boards for ' + userID, l)
        } else {
          this.ee.emit('error', err2)
        }
      })
    }
    return true // remove myself from listeners
  })
  return this.ee
}

BoardsAPI.prototype.getBoardSettings = function (userID, board, done) {
  if (!userID) {
    return console.log('Invalid USERID', userID)
  }
  if (!board) {
    return console.log('Invalid BOARD', board)
  }
  this.resolveIPNS(userID, (r, e) => {
    if (e) {
      this.ee.emit('error', e)
    } else {
      var url = r + this.baseurl + 'boards/' + board + '/settings.json'
      this.cat(url, (err, resp) => {
        var settings
        try {
          settings = JSON.parse(resp.toString())
        } catch (e) {
          this.ee.emit('error', e)
          if (done && done.apply) done(e)
          return
        }
        if (err) {
          this.ee.emit('error', err)
          if (done && done.apply) done(err)
        } else {
          // SETTINGS file is here, need to parse it a little bit
          this.ee.emit('settings for ' + board + '@' + userID, settings, r)
          if (done && done.apply) done(null, settings)
          if (settings.whitelist === true) {
            // Get the whitelist
            var url = r + this.baseurl + 'boards/' + board + '/whitelist'
            this.cat(url, (err, res) => {
              if (err) {
                this.ee.emit('error', err)
                // Emit an empty whitelist.
                this.ee.emit('whitelist for ' + board + '@' + userID, [])
              } else {
                replyAsObj(res, false, (err, whitelist) => {
                  if (err) {
                    // Emit an empty whitelist.
                    this.ee.emit('whitelist for ' + board + '@' + userID, [])
                  } else {
                    // Send whitelist
                    var w = whitelist.split(' ').map(x => x.trim())
                    this.ee.emit('whitelist for ' + board + '@' + userID, w)
                  }
                })
              }
            })
          }
          if (!settings.whitelist_only && !settings.approval_required && settings.blacklist === true) {
            // Get the blacklist
            var u = r + this.baseurl + 'boards/' + board + '/blacklist'
            this.cat(u, (err, blacklist) => {
              if (err) {
                this.ee.emit('error', err)
              } else {
                // Send blacklist
                var w = blacklist.split(' ')
                this.emit('blacklist for ' + board + '@' + userID, w)
              }
            })
          }
        }
      })
    }
    return true // remove myself from listeners
  })
  return this.ee
}

BoardsAPI.prototype.downloadPost = function (hash, adminID, board, op, done) {
  if (typeof adminID === 'function') {
    done = adminID
    adminID = undefined
  }
  if (typeof board === 'function') {
    done = board
    board = undefined
  }
  if (typeof op === 'function') {
    done = op
    op = undefined
  }
  this.cat(hash, (err2, r) => {
    if (err2) {
      this.ee.emit('error', err2)
      console.log('Could not download post', hash, 'of', board + '@' + adminID)
      if (done && done.apply) done(err2)
    } else {
      replyAsObj(r, true, (err, post) => {
        if (err) {
          if (done && done.apply) return done(err)
          return
        }
        post.hash = hash
        if (op) post.op = op // Inject op
        if (board) {
          if (adminID) this.ee.emit('post in ' + board + '@' + adminID, hash, post.date, post)
          else this.ee.emit('post in ' + board, hash, post.date, post)
        }
        this.ee.emit(hash, post, adminID, board)
        if (done && done.apply) done(null, hash, post.date, post)
      })
    }
  })
  return this.ee
}

BoardsAPI.prototype.retrieveListOfApproved = function (what, addr, adminID, board) {
  var a = addr + this.baseurl + 'boards/' + board + '/approved/' + what + '/'
  this.ls(a, (err, res) => {
    if (err) {
      this.ee.emit('error', err)
    } else {
      // Send approved posts list
      var ret = res.Objects[0].Links.map(item => {
        return { date: item.Name, hash: item.Hash }
      })
      this.emit('approved ' + what + ' for ' + board + '@' + adminID, ret)
    }
  })
}

BoardsAPI.prototype.getAllowedContentProducers = function (adminID, board, options) {
  if (!options) return
  this.ee.on('settings for ' + board + '@' + adminID, function (settings, addr) {
    // Get stuff based on settings
    if (settings.approval_required === true) {
      // Get approved posts list
      if (options.posts) this.retrieveListOfApproved('posts', addr, adminID, board)
      // Get approved comments list
      if (options.comments) this.retrieveListOfApproved('comments', addr, adminID, board)
    } else if (settings.whitelist_only === true) {
      // TODO: emit all whitelisted users
    } else if (settings.blacklist === true) {
      // TODO: emit all users not in the blacklist
    }
  })
  this.getBoardSettings(adminID, board)
  return this.ee
}

BoardsAPI.prototype.getPostsInBoard = function (adminID, board, opt) {
  opt = opt || {}
  var emitPost = i => this.ee.emit('post in ' + board + '@' + adminID, i.hash, i.date)
  if (adminID) {
    this.ee.on('approved posts for ' + board + '@' + adminID, ret => {
      // Automatically download approved posts
      ret.forEach(emitPost)
    })
    this.ee.on('whitelist for ' + board + '@' + adminID, whitelist => {
      // download posts for each user in whitelist
      whitelist.forEach(item => {
        this.getUserPostListInBoard(item, board, (err, postList) => {
          if (!err) postList.forEach(emitPost)
        })
      })
    })
    // Get allowed content and content producers
    this.getAllowedContentProducers(adminID, board, { posts: true })
    // Get the admin's posts
    this.getUserPostListInBoard(adminID, board, (err, res) => {
      if (!err) res.forEach(emitPost)
    })
  } else {
    // TODO: Download all posts in board from everyone
    // Download my posts
    this.getUserPostListInBoard(this.id, board, (err, res) => {
      if (err) {
        console.log(err)
      } else res.forEach(emitPost)
    })
  }
  return this.ee
}

BoardsAPI.prototype.getUserPostListInBoard = function (user, board, done) {
  this.resolveIPNS(user, (url, err) => {
    if (err) {
      this.ee.emit('error', err)
      done(err)
    } else {
      this.ls(url + this.baseurl + 'posts/' + board, (e, r) => {
        if (e) {
          this.ee.emit('error', e)
          done(e)
        } else if (r && !r.split) {
          console.log('Found', r.Objects[0].Links.length, 'posts in', board, 'at', user)
          this.ee.emit('post count', board, user, r.Objects[0].Links.length)
          var l = r.Objects[0].Links.map(i => {
            return { date: i.Name, hash: i.Hash }
          })
          done(null, l)
        }
      })
    }
    return true // remove myself from listeners
  })
  return this.ee
}

BoardsAPI.prototype.downloadComment = function (hash, adminID, board, target, done) {
  if (!done && typeof target === 'function') {
    done = target
    target = undefined
  }
  this.cat(hash, (err2, r) => {
    if (err2) {
      this.ee.emit('error', err2)
      console.log('Could not download comment', hash, 'of', board + '@' + adminID)
      if (done) done(err2)
    } else {
      // TODO: add JSON parsing error handling
      var cmnt = JSON.parse(r.toString())
      cmnt.hash = hash
      if (target) {
        cmnt.original_parent = cmnt.parent
        cmnt.parent = target
      }
      this.ee.emit(hash, cmnt, adminID, board)
      this.ee.emit('comment for ' + (target || cmnt.parent), cmnt)
      if (done) done(null, cmnt)
    }
  })
  return this.ee
}

BoardsAPI.prototype.getCommentsFor = function (parent, board, adminID, target, list = [parent]) {
  if (!parent || !board || !adminID) {
    return console.log('malformed arguments:', parent, board, adminID, target, list)
  }
  // figure out if there's a previous version of the item
  this.cat(parent, (err, res) => {
    if (err) {
      this.ee.emit('error', err)
    } else {
      replyAsObj(res, true, (err2, obj) => {
        if (err2) {
          this.ee.emit('error', err2)
        } else if (typeof obj.previous === 'string' && list.indexOf(obj.previous) < 0) {
          // Also get comments for the previous version of the parent!
          this.getCommentsFor(obj.previous, board, adminID, (target || parent), list.concat(obj.previous))
        }
      })
    }
  })
  // get the admin's comments
  this.getUserCommentList(parent, adminID, (err, res) => {
    if (!err) {
      res.forEach(item => this.downloadComment(item.hash, adminID, board, target))
    }
  })
  // Download comments from whitelisted
  this.ee.on('whitelist for ' + board + '@' + adminID, whitelist => {
    // download posts for each user in whitelist
    whitelist.forEach(item => {
      this.getUserCommentList(parent, item, (err, res) => {
        if (err) return
        res.forEach(i => this.downloadComment(i.hash, adminID, board, target))
      })
    })
  })
  // Handle approved comments
  this.ee.on('approved comments for ' + board + '@' + adminID, ret => {
    ret.forEach(item => this.downloadComment(item.hash, adminID, board, target))
  })
  this.getAllowedContentProducers(adminID, board, { comments: true })
}

BoardsAPI.prototype.getUserCommentList = function (parent, user, done) {
  if (!parent || !user) {
    return console.log('Malformed arguments:', parent, user)
  }
  this.resolveIPNS(user, (url, err) => {
    if (err) {
      this.ee.emit('error', err)
      done(err)
    } else {
      this.ls(url + this.baseurl + 'comments/' + parent, (e, r) => {
        if (e) {
          this.ee.emit('error', e)
          done(e)
        } else if (r && !r.split) {
          if (r.Objects && r.Objects[0]) { // If this is not true, then there are no comments
            console.log('Found', r.Objects[0].Links.length, 'comments for', parent, 'at', user)
            var l = r.Objects[0].Links.map(i => {
              return { date: i.Name, hash: i.Hash }
            })
            done(null, l)
          }
        }
      })
    }
    return true // remove myself from listeners
  })
  return this.ee
}

BoardsAPI.prototype.isRunningFromGateway = function () {
  if (!window) return false
  return window.location.pathname.indexOf('/ipfs/') === 0 || window.location.pathname.indexOf('/ipns/') === 0
}

BoardsAPI.prototype.isNode = function () {
  return process && process.env
}

// API for publishing content and managing to be done later...

// Initialize API
BoardsAPI.prototype.init = function (done) {
  if (this.isInit) return
  this.ipfs.version((err, res) => {
    if (err) {
      this.limited = this.isRunningFromGateway() ? 2 : false
      this.ee.emit('error', err)
      this.ee.emit('init', err, this.limited)
      console.log('Error while getting ipfs version:', err)
      if (done && done.apply) done(err, this.limited)
    } else {
      this.ipfs_version = res.Version.split('-')[0]
      console.log('IPFS Version is', res.Version)
      if (semver.satisfies(this.ipfs_version, '~0.4.0')) {
        console.log('IPFS version is supported')
        this.ipfs.id((err, res) => {
          if (err) {
            console.log('Error while getting OWN ID:', err)
            this.limited = this.isRunningFromGateway() ? 1 : false
            this.ee.emit('error', err)
            this.ee.emit('init', err, this.limited)
            if (done && done.apply) {
              done(err, this.limited)
            }
          } else if (res.ID) {
            console.log('I am', res.ID)
            this.id = res.ID
            this.resolveIPNS(res.ID)
            console.log('Version is', this.version)
            var file = {
              path: 'version',
              content: this.version
            }
            this.ipfs.add(file, (err2, r) => {
              if (err2) {
                this.ee.emit('error', err2)
                console.log('Error while calculating version hash:', err2)
                this.ee.emit('init', err2, this.limited)
                if (done && done.apply) done(err2)
              } else {
                if (r && r.Hash) this.versionHash = r.Hash
                if (r && r[0] && r[0].Hash) this.versionHash = r[0].Hash
                console.log('Version hash is', this.versionHash)
                // DONE!
                this.ee.emit('init', undefined)
                this.isInit = true
                delete this.init_error
                if (done && done.apply) done(null)
              }
            })
          }
        })
      } else {
        var e = { Message: 'IPFS Version not supported. This app supports go-ipfs 0.4.x' }
        if (done && done.apply) done(e)
        console.log('Error:', e.Message)
        this.ee.emit('error', e)
        this.ee.emit('init', e)
      }
    }
  })
}

BoardsAPI.prototype.getEventEmitter = function () {
  return this.ee
}

BoardsAPI.prototype.getUsers = function () {
  return this.users
}

BoardsAPI.prototype.getMyID = function () {
  return this.id
}

BoardsAPI.prototype.getIPFS = function () {
  return this.ipfs
}

module.exports = BoardsAPI
