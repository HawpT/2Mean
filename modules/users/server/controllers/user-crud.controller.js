/**
 * Database handle.
 */
var mongoose = require('mongoose');
//tell mongoose to use q promise library promises
mongoose.Promise = require('q').Promise;

/**
 * User model.
 */
var Users = mongoose.model('User');

/**
 * Q promise library.
 */
var q = require('q');

/*
 * Underscore/Lodash functionality.
 */
var _ = require('lodash');
var md5 = require('md5');
const roleConfig = require('../../../roles/server/config/config');
/**
 * Main business logic for handling requests.
 */
function userCrudController(logger, shared) {
  // --------------------------- Public Function Definitions ----------------------------
  const pageLimit = 25;
  const ADMIN_ROLE_NAME = 'admin';
  const DEFAULT_ROLE_NAME = 'user';

  let authHelpers = shared.authHelpers;
  let self = this;
 
  /**
   * Reads a user from the database if the permissions are adequate.
   *
   * @param {Request} req   The Express request object.
   * @param {Response} res  The Express response object.
   * @param {Next} next     The Express next (middleware) function.
   *
   * @return {Promise}
   */
  function read(req, res, next) {
    var user = req.user;

    var id = req.params.userId || null; 

    return new Promise((resolve, reject) => {
      if (!id) {
        // missing id
        reject(new Error('Malformed request'));
      } else if (isSelf(user, id) || isAuthorized(user, 'read')) {
        // check if allowed
        resolve(Users.findOne({ _id: id }).exec());
      } else {
        // not allowed
        reject(new Error('Forbidden'));
      }
    }).then((foundUser) => {
      if (foundUser) {
        res.status(200).send(sanitizeUser(user));
      } else {
        throw new Error('Not found');
      }
    }).catch((error) => {
      // handle errors. message sent depends on error message
      if (error.message === 'Malformed request') {
        res.status(400).send({ error: error.message });
      } else if(error.message === 'Forbidden') {
        res.status(403).send();
      } else if (error.message === 'Not found') {
        res.status(404).send();
      } else {
        logger.error('Error user.crud#read', error);
        res.status(500).send();
      }
    });
  }

  /**
  * Returns a list of users from the database sorted by
  * username. Page should be supplied as a url parameter
  *
  * @param {Request} req   The Express request object.
  * @param {Response} res  The Express response object.
  * @param {Function} next     The Express next (middleware) function.
  *
  * @return {Promise}
  */
  function list(req, res, next) {
    let page = req.query.page || 1;
    let search = req.query.search || "";
    let skip = (page - 1) * pageLimit;
    let queryObj;

    if (search === "") {
      queryObj = {};
    } else {
      queryObj = {
        'username': new RegExp('[a-z]*'+search +'+?', 'i')
      };
    }

    return Users.find(queryObj)
      .sort('username')
      .skip(skip)
      .limit(pageLimit)
      .exec()
      .then((foundUsers) => {
        let sanitized = [];

        for (let i in foundUsers) {
          sanitized.push(sanitizeUser(foundUsers[i]));
        }

        res.status(200).send(sanitized);
      }).catch((error) => {
        logger.error('Error user.crud#list', error);
        res.status(500).send();
      });
  }

  /**
   * Main function to handle create for the users collection.
   *
   * @param {Request} req   The Express request object.
   * @param {Response} res  The Express response object.
   * @param {Next} next     The Express next (middleware) function.
   *
   * @return {Promise}
   */
  function create(req, res, next) {
    var user = req.user;

    var body = req.body;

    return new Promise((resolve, reject) => {
      if (isAuthorized(user, 'create')) {
        let newUser = mapUser(body);
        newUser.profileImageURL = generateProfileImageURL(newUser.email);

        resolve(newUser.save());
      } else {
        reject(new Error('Forbidden'));
      }
    }).then((savedUser) => {
      logger.info('User created', { username: savedUser.username });
      res.status(201).send(sanitizeUser(savedUser));
    }).catch((error) => {
      if (error.errors) {
        res.status(400).send({ error: error.errors });
      } else if (error.message === 'Forbidden') {
        res.status(403).send();
      } else {
        logger.error('Error user.crud#create', error);
        res.status(500).send();
      }
    });
  }

  /**
   * Main function to handle update for the users collection.
   *
   * @param {Request}  req  The Express request object.
   * @param {Response} res  The Express response object.
   * @param {Next}     next The Express next (middleware) function.
   *
   * @return {Promise}
   */
  async function update(req, res, next) {
    let foundUser, savedUser;
    var user = req.user;

    var updates = req.body;

    if (updates._id) {
      try {
        foundUser = await Users.findOne({ _id: updates._id }).exec();
      } catch (error) {
        logger.error('Error in user.crud#update findOne', error);
        return res.status(500).send();
      }
    } else {
      return res.status(400).send({ error: 'Missing user._id' });
    }
    
    if (!foundUser) {
      return res.status(404).send();
    }

    // update the found user
    mapOverUser(updates, foundUser);
      
    foundUser.updated = new Date();
    
    try {
      savedUser = await foundUser.save();
    } catch(error) {
      if (error.errors) {
        return res.status(400).send({ error: error.errors });
      } else if (error.message === 'Not found') {
        return res.status(404).send();
      } else {
        logger.error('Error user.crud#update', error);
        return res.status(500).send();
      }
    }
      
    return res.status(200).send(sanitizeUser(savedUser));
  }

  /**
   * Main function to handle delete for the users collection.
   *
   * The request should be a comma separated list of id's in a GET request (per the routes config).
   *
   * @param {Request}  req  The Express request object.
   * @param {Response} res  The Express response object.
   *
   * @return {void}
   */
  function readList(req, res) {
    var userList = req.params.userList.split(',');

    return Users.find({ _id: { $in: userList } })
      .select(this.SANITIZED_SELECTION)
      .exec()
      .then((foundUsers) => {
        for (let i = 0; i < foundUsers.length; i++) {
          foundUsers[i] = sanitizeUser(foundUsers[i]);
        }

        res.status(200).send(foundUsers);
      }).catch((error) => {
        logger.error('Error user.crud#readList', error);
        res.status(500).send();
      });
  }

  /**
   * Main function to handle delete for the users collection.
   *
   * @param {Request} req   The Express request object.
   * @param {Response} res  The Express response object.
   * @param {Next} next     The Express next (middleware) function.
   *
   * @return {void}
   */
  function deleteUser(req, res, next) {
    var userId = req.params.userId;
    
    return new Promise((resolve, reject) => {
      if (isAuthorized(req.user, 'delete')) {
        resolve(Users.findOne({ _id: userId }).remove());
      } else {
        reject(new Error('Forbidden'));
      }
    }).then((result) => {
      res.status(204).send();
    }).catch((error) => {
      if (error.message === 'Forbidden') {
        res.status(403).send();
      } else {
        logger.error('Error user.crud#deleteUser', error);
        res.status(500).send();
      }
    });
  }


  /**
   * Handles user updates sent by an admin user
   * @param {Request} req   The Express request object
   * @param {Response} res  The Express response object
   */
  async function adminUpdate(req, res) {
    if(req.user.role != roleConfig.ADMIN_ROLE_NAME){
      return res.status(403).send();
    }

    let user = req.body;
    //update role if necessary
    if (user.role) {
      user.subroles = await self.roleModule.determineSubroles(user.role);
    }
    
    if (user.password) {
      try {
        user.password = await authHelpers.hashPassword(user.password);
      } catch (error) {
        logger.error('Error in user.crud#adminUpdate hash password', error);
        return res.status(500).send();
      }
    }

    let updateDef = { $set: user };
    //send update to mongo
    let results;
    try {
      results = await Users.findOneAndUpdate({ _id: req.body._id}, updateDef).exec();
    } catch (error) {
      logger.error('Error in user.crud#adminUpdate findOneAndUpdate', error);
      return res.status(500).send();
    }
    
    return res.status(204).send();
  }

  /*
   * Updates all subroles for a given role 
   */
   function flushSubroles(parentRole, subroles)
   {
      logger.info("Updating user subroles");
      Users.update({role: parentRole}, {$set: {subroles: subroles}},{multi: true}, (err, data) =>
      {
        if(err)
        {
          logger.error("error updating subroles for affected users", err.errmsg)
        }
      });
   }

   function removeSubroles(subroles)
   {
      logger.info("removing subroles " + subroles);
      logger.info(subroles);
      for(let i = 0; i < subroles.length; i++)
      {
        Users.update({subroles: subroles[i]}, {$pull: {subroles: subroles[i]}}, {multi: true}, function(err, data)
        {
          if(err)
          {
            logger.error(err);
          }
        });
      }
     
   }

   /**
    * Updates a users roles
    * @param {userId} the id of the user to update
    * @param {targetRole} the role to place the user in
    * @param {subroles} a list of corres
    * @returns {Promise} an update promise
    */
   function updateUserRoles(userId, targetRole, subroles) {
     let query = {_id: userId};
     let update = {$set: {role: targetRole, subroles: subroles}};
     return Users.update(query, update);
     
   }
   
  /**
   * method for getting own user (provided by req.user)
   */
  function readSelf(req, res, next) {
    let user = req.user;

    res.status(200).send(sanitizeUser(user));
  }


  // --------------------------- Private Function Definitions ----------------------------

  /**
   * Given an array of ids, this function will retrieve the user objects.
   *
   * @param {Array<String>} userIdList The array of ids to lookup.
   *
   * @return {Array<Users>}
   */
  function getListOfUsers(userIdList) {
  }
  
  /*
   * Checks if the request is to the requestors data.
   */
  function isSelf(user, id) {
    if (user._id === id) {
      return true;
    }
    return false;
  }

  /*
   * Verfies the user is authorized to make changes.
   *
   * TODO: This could probably be more robust.
   */
  function isAuthorized(user, action) {
    if (user.subroles.includes(ADMIN_ROLE_NAME)) {
      return true;
    }

    return false;
  }

  function sanitizeUser(user) {
    // cheat a deep copy with JSON
    let sanitized = JSON.parse(JSON.stringify(user));
    sanitized.password = undefined;
    // remove the token. The user has to look at their email. no cheating
    if (sanitized.verification) {
      sanitized.verification.token = undefined;
    }
    // remove password rest token
    if (sanitized.resetPassword) {
      sanitized.resetPassword.token = undefined;
    }

    return sanitized;
  }
  /*
   * Maps the post request representation of a user to a mongoose User model.
   *
   * @param {Object} body The body of the request.
   *
   * @return {User}
   */
  function mapUser(body) {
    var user = new Users();
    var schemaFields = Users.schema.obj;
    var index;

    for(index in Object.keys(schemaFields)) {
      let realIndex = Object.keys(schemaFields)[index];
      if (body[realIndex]) {
        user[realIndex] = body[realIndex];
      }
    }

    user.updated = new Date();
    user.created = new Date();

    return user;
  }
  
  function generateProfileImageURL(email) {
    let hash = md5(email.toLowerCase());
    return 'https://gravatar.com/avatar/' + hash + '?d=identicon';
  }

  /**
   * Called by the role module to avoid a circular dependency
   * @param { Object } roleModule 
   */
  function setRoleModule(roleModule) {
    self.roleModule = roleModule;
  }
    
  /**
   * @param {Object} updates 
   * @param {Object} user
   */
  function mapOverUser(updates, user) {
    let schemaFields = Users.schema.obj;

    for (let index in Object.keys(schemaFields)) {
      let realIndex = Object.keys(schemaFields)[index];
      if (updates[realIndex] !== undefined) {
        user[realIndex] = updates[realIndex];
      }
    }
  }

  // --------------------------- Revealing Module Section ----------------------------

  return {
    read                  : read,
    create                : create,
    update                : update,
    deleteUser            : deleteUser,
    adminUpdate           : adminUpdate,
    updateUserRoles       : updateUserRoles,
    setRoleModule         : setRoleModule,
    flushSubroles         : flushSubroles,
    removeSubroles        : removeSubroles,
    readList              : readList,
    list                  : list,
    readSelf              : readSelf
  };
}

module.exports = userCrudController;
