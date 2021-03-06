/**
 * Database handle.
 */
const mongoose = require('mongoose');
const ObjectId = mongoose.Schema.ObjectId;

/**
 * User model.
 */
const Users = mongoose.model('User');

/**
 * Key model.
 */
const Keys = mongoose.model('Keys');

/**
 * Q promise library.
 */
const q = require('q');

/*
 * Underscore/Lodash functionality.
 */
const _ = require('lodash');

/*
 * fs for unlinking files
 */
const fs = require('fs');

/*
 * application config
 */
const config = require('../../../../config/config');

const md5 = require('md5');

/**
 * Main business logic for handling requests.
 */
function userAuthController(logger, shared) {
  // --------------------------- Public Function Definitions ----------------------------
  const pageLimit = 25;

  var authHelpers = shared.authHelpers;

  /**
   * Registers a new user with bare minimum roles.
   *
   * @param {Request} req   The Express request object.
   * @param {Response} res  The Express response object.
   * @param {Next} next     The Express next (middleware) function.
   *
   * @return {void}
   */
  async function register(req, res, next) {
    var user = req.user;

    var body = req.body;

    var deferred = q.defer();

    var SANITIZED_SELECTION = 'created displayName email firstName lastName profileImageURL role subroles username';

    let newUser = mapUser(body);

    newUser.profileImageURL = generateProfileImageURL(newUser.email);

    // Overwrite any roles set or make sure they get set appropriately.
    newUser.role = config.app.defaultUserRole;

    if (!config.app.allowRegistration) {
      logger.warn('Registration is disabled but someone tried to signup');
      return res.status(500).send();
    } else if (!isStrongPassword(newUser.password)) {
      return res.status(400).send({ error: 'Invalid password: ' + config.auth.invalidPasswordMessage });
    }

    let hash = await authHelpers.hashPassword(newUser.password);
      
    newUser.password = hash;
      
    newUser.verification = {
      token: authHelpers.generateUniqueToken(),
      expires: Date.now() + config.app.emailVerificationTTL
    };

    // save the user
    let savedUser;
    try {
      savedUser = await newUser.save();
    } catch (error) {
      if (error.code === 11000) {
        // check for specific codes to provide feedback to ui
        let errObj = error.toJSON();
        let errmsg = errObj.errmsg;
        let errmsgList = errmsg.split(' ');
        // index is the duplicate key
        let index = errmsgList[errmsgList.indexOf('index:')+1];

        // TODO implement email-password login and registration
        // confirmation emails. Otherwise usernames could be enumerated
        // with this endpoint. Until then send back generic error
        // message

        if (index === 'username_1') {
          return res.status(400).send({ error: 'Username is taken' });
        } else {
          return res.status(500).send();
        }
        
        
      } else {
        logger.error('Error in User.auth#register', error);
        return res.status(500).send();
      }

    }
      
    logger.info('User created: ' + newUser.username);

    if (config.app.requireEmailVerification) {
      try {
        let mailInfo = await sendEmailVerificationEmail(newUser);
        return res.status(201).send({ user: savedUser });
      } catch (error) {
        logger.error('Error sending verification email', error);
        return res.status(201).send({ user: savedUser, message: 'Verification email not sent' });
      }
    } else {
      return res.status(201).send({ user: savedUser });
    }
  }

  /**
   * changes a user's password if the password sent is verified with their old
   * hash
   *
   * @param {Request}   req   The Express request object
   *                    req.body.newPassword
   * @param {Response}  res   The Express response object
   * @param {Next}      next  The Express next (middleware) function
   *
   * @returns {void}
   */
  function changePassword(req, res, next) {
    // this is the user injected by the auth middleware
    var user = req.user;
    
    // this is the old password the user has entered
    let oldPassword = req.body.oldPassword;

    // this is the password the user wants to change to
    let newPassword = req.body.newPassword;

    return authHelpers.verifyPassword(user.password, oldPassword).then((match) => {
      if (match) {
        // check password strength
        if (!isStrongPassword(newPassword)) {
          throw new Error('Invalid password');
        } else {
          return authHelpers.hashPassword(newPassword);
        }
      } else {
        throw new Error('Incorrect password');
      }
    }).then((hash) => {
      // password has been hashed save it to the user
      user.password = hash;

      return user.save();
    }).then((savedUser) => {
      // user has been saved
      res.status(200).send(savedUser);
    }).catch((error) => {
      // something rejected or threw up
      // extract any mongoose errors
      let errors = extractMongooseErrors(error.errors);
      let validation = _.filter(errors, (o) => {
        return o.name === 'ValidatorError';
      });

      if (validation.length) {
        // error is from mong
        res.status(400).send({
          message: error.message
        });
      } else if (error.message === 'Invalid password') {
        // user sent an invalid new password
        res.status(400).send({
          message: 'Invalid password: ' + config.auth.invalidPasswordMessage
        });
      } else if (error.message === 'Incorrect password') {
        // user sent wrong old password
        logger.info('Incorrect password', { username: user.username });
        res.status(400).send({ message: 'Incorrect Username/Password' });
      } else {
        // not sure what went wrong
        logger.error('Error changing password', error);
        res.status(500).send();
      }
    });
  }

  /**
   * verifies that the user has access to the email they registered with
   * @param {Object} req
   * @param {Object} res
   * @param {Function} next
   * @return {Promise}
   */
  function verifyEmail(req, res, next) {
    let token = req.query.token;

    // try to find the token and the user it is attached to
    return Users.findOne({ 'verification.token': token }).exec().then((user) => {
      if (!user) {
        throw new Error('Token invalid');
      } else if (Date.now() > user.verification.expires) {
        throw new Error('Token has expired');
      } else {
        user.verification.expires = undefined;
        user.verified = true;

        return user.save()
      }
    }).then((savedUser) => {
      res.status(204).send();
    }).catch((error) => {
      if (error.message === 'Token has expired') {
        res.status(400).send({ message: 'Token has expired' });
      } else if (error.message === 'Token invalid') {
        res.status(400).send({ message: 'Token invalid' });
      } else {
        logger.error('Error verifying email: ', error);
        res.status(500).send();
      }
    });
  }

  /**
   * request that a new verification email with a new token is sent
   */
  function requestVerifcationEmail(req, res, next) {
    let user = req.user;
    
    user.verification.token = authHelpers.generateUniqueToken();
    user.verification.expires = Date.now() + config.app.emailVerificationTTL;

    return user.save().then((savedUser) => {
      return sendEmailVerificationEmail(savedUser);
    }).then((mailInfo) => {
      res.status(204).send();
    }).catch((error) => {
      logger.error(error);
      res.status(500).send();
    });
  }

  /**
   * request that a new password reset email with a new token is sent
   */
  function requestChangePasswordEmail(req, res, next) {
    return new Promise((resolve, reject) => {
      if (req.query.email) {
        resolve(Users.find({ email: req.query.email }).exec());
      } else {
        reject(new Error('Missing email'));
      }
    }).then((users) => {
      let user;

      if (users.length === 1) {
        user = users[0];
      } else {
        // email is unique so can safely assume that only other case is zero
        throw new Error('Email not found');
      }

      user.resetPassword = {
        token: authHelpers.generateUniqueToken(),
        expires: Date.now() + config.app.emailVerificationTTL
      };

      return user.save();
    }).then((savedUser) => {
      return sendPasswordChangeEmail(savedUser);
    }).then((mailInfo) => {
      res.status(204).send();
    }).catch((error) => {
      if (error.message === 'Missing email') {
        res.status(400).send({ error: 'Missing email' });
      } else if (error.message === 'Email not found') {
        res.status(400).send({ error: 'Email not found' });
      } else {
        logger.error('Error in User.auth#requestChangePasswordEmail', error);
        res.status(500).send();
      }
    });
  }

  /**
   * change a forgotten password
   */
  function resetPassword(req, res, next) {
    let user;
    
    return new Promise((resolve, reject) => {
      if (!req.body.password) {
        reject(new Error('Missing password'));
      } else if (!req.body.token) {
        reject(new Error('Missing token'));
      } else if (isStrongPassword(req.body.password)) {
        resolve(Users.find({ 'resetPassword.token': req.body.token }).exec());
      } else {
        reject(new Error('Password invalid'));
      }
    }).then((users) => {
      if (users.length === 1) {
        user = users[0];
      } else {
        throw new Error('Token invalid');
      }
      
      if (Date.now() > user.resetPassword.expires) {
        throw new Error('Token has expired');
      }

      return shared.authHelpers.hashPassword(req.body.password);
    }).then((hashed) => {
      user.password = hashed;
      user.resetPassword = {};
      user.verified = true;

      return user.save();
    }).then((savedUser) => {
      res.status(204).send();
    }).catch((error) => {
      if (error.message === 'Missing token') {
        res.status(400).send({ error: 'Missing token' });
      } else if (error.message === 'Missing password') {
        res.status(400).send({ error: 'Missing password' });
      } else if (error.message === 'Token invalid') {
        res.status(400).send({ error: 'Token invalid' });
      } else if (error.message === 'Password invalid') {
        res.status(400).send({ error: 'Password invalid' });
      } else if (error.message === 'Token has expired') {
        res.status(400).send({ error: 'Token has expired' });
      } else {
        logger.error('Error in User.auth#resetPassword', error);
        res.status(500).send();
      }
    });
  }

  // --------------------------- Private Function Definitions ----------------------------

  function extractMongooseErrors(error) {
    var errors = [];

    for (var field in error) {
      errors.push(error[field]);
    }

    return errors;
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

  /*
   * checks the password is valid
   * by default:
   *  the password contain UPPER, lower, digit, and 5ymb0l
   *  the password must be at least 8 characters long
   * theses validation settings can be changed in the configuration
   */
  function isStrongPassword(password) {
    // get config (/config/config.js)
    var strengthRe = config.auth.passwordStrengthRe;

    // apply the re
    return strengthRe.test(password);
  }

  function generateProfileImageURL(email) {
    let hash = md5(email.toLowerCase());
    return 'https://gravatar.com/avatar/' + hash + '?d=identicon';
  }

  /**
   * sends a verification email to the user
   * @param {Object} user
   * @return {Promise}
   */
  function sendEmailVerificationEmail(user) {
    const url = authHelpers.generateUrl() + '/verifyEmail;token=' + user.verification.token;
    const subject = 'Verification Email';
    const to = user.email;
    const from = config.email.from;
    const text= 'Verify your email by going here: ' + url;

    const emailParams = {
      from: from,
      to: to,
      text: text,
      subject: subject
    };

    return shared.mail.sendMail(emailParams);
  }

  /**
   * sends a password change email to the user
   * @param {Object} user
   * @return {Promise}
   */
  function sendPasswordChangeEmail(user) {
    const url = authHelpers.generateUrl() + '/reset-password;token=' + user.verification.token;
    const subject = 'Change Password';
    const to = user.email;
    const from = config.email.from;
    const text = 'Change your password by going here: ' + url;

    const emailParams = {
      from: from,
      to: to,
      text: text,
      subject: subject
    };

    return shared.mail.sendMail(emailParams);
  }

  // --------------------------- Revealing Module Section ----------------------------

  return {
    register              : register,
    changePassword        : changePassword,
    verifyEmail: verifyEmail,
    requestVerificationEmail: requestVerifcationEmail,
    requestChangePasswordEmail: requestChangePasswordEmail,
    resetPassword: resetPassword
  };
}

module.exports = userAuthController;
