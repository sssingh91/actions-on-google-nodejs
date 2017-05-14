/**
 * Copyright 201 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The Actions on Google client library AssistantApp base class.
 *
 * This class contains the methods that are shared between platforms to support the conversation API
 * protocol from Assistant. It also exports the 'State' class as a helper to represent states by
 * name.
 */

'use strict';

const Debug = require('debug');
const debug = Debug('actions-on-google:debug');
const error = Debug('actions-on-google:error');

// Response Builder classes
const RichResponse = require('./response-builder').RichResponse;
const BasicCard = require('./response-builder').BasicCard;
const List = require('./response-builder').List;
const Carousel = require('./response-builder').Carousel;
const OptionItem = require('./response-builder').OptionItem;
const isSsml = require('./response-builder').isSsml;

const transformToSnakeCase = require('./utils/transform').transformToSnakeCase;
const transformToCamelCase = require('./utils/transform').transformToCamelCase;

// Constants
const ERROR_MESSAGE = 'Sorry, I am unable to process your request.';
const API_ERROR_MESSAGE_PREFIX = 'Action Error: ';
const CONVERSATION_API_VERSION_HEADER = 'Google-Assistant-API-Version';
const ACTIONS_CONVERSATION_API_VERSION_HEADER = 'Google-Actions-API-Version';
const ACTIONS_CONVERSATION_API_VERSION_TWO = 2;
const RESPONSE_CODE_OK = 200;
const RESPONSE_CODE_BAD_REQUEST = 400;
const HTTP_CONTENT_TYPE_HEADER = 'Content-Type';
const HTTP_CONTENT_TYPE_JSON = 'application/json';

// Configure logging for hosting platforms that only support console.log and console.error
debug.log = console.log.bind(console);
error.log = console.error.bind(console);

/**
 * Constructor for AssistantApp object.
 * Should not be instantiated; rather instantiate one of the subclasses
 * {@link ActionsSdkApp} or {@link ApiAiApp}.
 *
 * @param {Object} options JSON configuration.
 * @param {Object} options.request Express HTTP request object.
 * @param {Object} options.response Express HTTP response object.
 * @param {Function=} options.sessionStarted Function callback when session starts.
 */
const AssistantApp = class {
  constructor (options) {
    debug('AssistantApp constructor');

    if (!options) {
      // ignore for JavaScript inheritance to work

      // As a workaround for pre-existing sample code which incorrectly
      // initializes this class without an options object.
      this.StandardIntents = {
        MAIN: 'assistant.intent.action.MAIN',
        TEXT: 'assistant.intent.action.TEXT',
        PERMISSION: 'assistant.intent.action.PERMISSION'
      };
      return;
    }
    if (!options.request) {
      this.handleError_('Request can NOT be empty.');
      return;
    }
    if (!options.response) {
      this.handleError_('Response can NOT be empty.');
      return;
    }

    /**
     * The Express HTTP request that the endpoint receives from the Assistant.
     * @private
     * @type {Object}
     */
    this.request_ = options.request;

    /**
     * The Express HTTP response the endpoint will return to Assistant.
     * @private
     * @type {Object}
     */
    this.response_ = options.response;

    /**
     * 'sessionStarted' callback (optional).
     * @private
     * @type {Function}
     */
    this.sessionStarted_ = options.sessionStarted;

    debug('Request from Assistant: %s', JSON.stringify(this.request_.body));

    /**
     * The request body contains query JSON and previous session variables.
     * Assignment using JSON parse/stringify ensures manipulation of this.body_
     * does not affect passed in request body structure.
     * @private
     * @type {Object}
     */
    this.body_ = JSON.parse(JSON.stringify(this.request_.body));

    /**
     * API version describes version of the Actions API request.
     * @private
     * @type {string}
     */
    this.actionsApiVersion_ = null;
    // Populates API version from either request header or APIAI orig request.
    if (this.request_.get(ACTIONS_CONVERSATION_API_VERSION_HEADER)) {
      this.actionsApiVersion_ = this.request_.get(ACTIONS_CONVERSATION_API_VERSION_HEADER);
      debug('Actions API version from header: ' + this.actionsApiVersion_);
    }
    if (this.body_.originalRequest &&
      this.body_.originalRequest.version) {
      this.actionsApiVersion_ = this.body_.originalRequest.version;
      debug('Actions API version from APIAI: ' + this.actionsApiVersion_);
    }

    // If request is in Proto2 format, convert to Proto3
    if (!this.isNotApiVersionOne_()) {
      if (this.body_.originalRequest) {
        this.body_.originalRequest = transformToCamelCase(this.body_.originalRequest);
      } else {
        this.body_ = transformToCamelCase(this.body_);
      }
    }

    /**
     * Intent handling data structure.
     * @private
     * @type {Object}
     */
    this.handler_ = null;

    /**
     * Intent mapping data structure.
     * @private
     * @type {Object}
     */
    this.intentMap_ = null;

    /**
     * Intent state data structure.
     * @private
     * @type {Object}
     */
    this.stateMap_ = null;

    /**
     * The session state.
     * @public
     * @type {string}
     */
    this.state = null;

    /**
     * The session data in JSON format.
     * @public
     * @type {Object}
     */
    this.data = {};

    /**
     * The API.AI context.
     * @private
     * @type {Object}
     */
    this.contexts_ = {};

    /**
     * The last error message.
     * @private
     * @type {string}
     */
    this.lastErrorMessage_ = null;

    /**
     * Track if an HTTP response has been sent already.
     * @private
     * @type {boolean}
     */
    this.responded_ = false;

    /**
     * List of standard intents that the app provides.
     * @readonly
     * @enum {string}
     * @actionssdk
     * @apiai
     */
    this.StandardIntents = {
      /** Assistant fires MAIN intent for queries like [talk to $action]. */
      MAIN: this.isNotApiVersionOne_() ? 'actions.intent.MAIN' : 'assistant.intent.action.MAIN',
      /** Assistant fires TEXT intent when action issues ask intent. */
      TEXT: this.isNotApiVersionOne_() ? 'actions.intent.TEXT' : 'assistant.intent.action.TEXT',
      /** Assistant fires PERMISSION intent when action invokes askForPermission. */
      PERMISSION: this.isNotApiVersionOne_() ? 'actions.intent.PERMISSION' : 'assistant.intent.action.PERMISSION',
      /** App fires OPTION intent when user chooses from options provided. */
      OPTION: 'actions.intent.OPTION'
    };

    /**
     * List of supported permissions the app supports.
     * @readonly
     * @enum {string}
     * @actionssdk
     * @apiai
     */
    this.SupportedPermissions = {
      /**
       * The user's name as defined in the
       * {@link https://developers.google.com/actions/reference/conversation#UserProfile|UserProfile object}
       */
      NAME: 'NAME',
      /**
       * The location of the user's current device, as defined in the
       * {@link https://developers.google.com/actions/reference/conversation#Location|Location object}.
       */
      DEVICE_PRECISE_LOCATION: 'DEVICE_PRECISE_LOCATION',
      /**
       * City and zipcode corresponding to the location of the user's current device, as defined in the
       * {@link https://developers.google.com/actions/reference/conversation#Location|Location object}.
       */
      DEVICE_COARSE_LOCATION: 'DEVICE_COARSE_LOCATION'
    };

    /**
     * List of built-in argument names.
     * @readonly
     * @enum {string}
     * @actionssdk
     * @apiai
     */
    this.BuiltInArgNames = {
      /** Permission granted argument. */
      PERMISSION_GRANTED: this.isNotApiVersionOne_() ? 'PERMISSION' : 'permission_granted'
    };

    /**
     * The property name used when specifying an input value data spec.
     * @readonly
     * @type {string}
     * @actionssdk
     * @apiai
     */
    this.ANY_TYPE_PROPERTY_ = '@type';

    /**
     * List of built-in value type names.
     * @readonly
     * @enum {string}
     * @actionssdk
     * @apiai
     */
    this.InputValueDataTypes_ = {
      /** Permission Value Spec. */
      PERMISSION: 'type.googleapis.com/google.actions.v2.PermissionValueSpec',
      /** Option Value Spec. */
      OPTION: 'type.googleapis.com/google.actions.v2.OptionValueSpec'
    };

    /**
     * List of possible conversation stages, as defined in the
     * {@link https://developers.google.com/actions/reference/conversation#Conversation|Conversation object}.
     * @readonly
     * @enum {number}
     * @actionssdk
     * @apiai
     */
    this.ConversationStages = {
      /**
       * Unspecified conversation state.
       */
      UNSPECIFIED: this.isNotApiVersionOne_() ? 'UNSPECIFIED' : 0,
      /**
       * A new conversation.
       */
      NEW: this.isNotApiVersionOne_() ? 'NEW' : 1,
      /**
       * An active (ongoing) conversation.
       */
      ACTIVE: this.isNotApiVersionOne_() ? 'ACTIVE' : 2
    };

    /**
     * List of surface capabilities supported by the app.
     * @readonly
     * @enum {string}
     * @actionssdk
     * @apiai
     */
    this.SurfaceCapabilities = {
      /**
       * The ability to output audio.
       */
      AUDIO_OUTPUT: 'actions.capability.AUDIO_OUTPUT',
      /**
       * The ability to output on a screen
       */
      SCREEN_OUTPUT: 'actions.capability.SCREEN_OUTPUT'
    };

    /**
     * List of possible user input types.
     * @readonly
     * @enum {number}
     * @actionssdk
     * @apiai
     */
    this.InputTypes = {
      /**
       * Unspecified.
       */
      UNSPECIFIED: this.isNotApiVersionOne_() ? 'UNSPECIFIED' : 0,
      /**
       * Input given by touch.
       */
      TOUCH: this.isNotApiVersionOne_() ? 'TOUCH' : 1,
      /**
       * Input given by voice (spoken).
       */
      VOICE: this.isNotApiVersionOne_() ? 'VOICE' : 2,
      /**
       * Input given by keyboard (typed).
       */
      KEYBOARD: this.isNotApiVersionOne_() ? 'KEYBOARD' : 3
    };

    /**
     * API version describes version of the Assistant request.
     * @deprecated
     * @private
     * @type {string}
     */
    this.apiVersion_ = null;
    // Populates API version.
    if (this.request_.get(CONVERSATION_API_VERSION_HEADER)) {
      this.apiVersion_ = this.request_.get(CONVERSATION_API_VERSION_HEADER);
      debug('Assistant API version: ' + this.apiVersion_);
    }
  }

  // ---------------------------------------------------------------------------
  //                   Public APIs
  // ---------------------------------------------------------------------------

  /**
   * Handles the incoming Assistant request using a handler or Map of handlers.
   * Each handler can be a function callback or Promise.
   *
   * @example
   * // Actions SDK
   * const app = new ActionsSdkApp({request: request, response: response});
   *
   * function mainIntent (app) {
   *   const inputPrompt = app.buildInputPrompt(true, '<speak>Hi! <break time="1"/> ' +
   *         'I can read out an ordinal like ' +
   *         '<say-as interpret-as="ordinal">123</say-as>. Say a number.</speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *   app.ask(inputPrompt);
   * }
   *
   * function rawInput (app) {
   *   if (app.getRawInput() === 'bye') {
   *     app.tell('Goodbye!');
   *   } else {
   *     const inputPrompt = app.buildInputPrompt(true, '<speak>You said, <say-as interpret-as="ordinal">' +
   *       app.getRawInput() + '</say-as></speak>',
   *         ['I didn\'t hear a number', 'If you\'re still there, what\'s the number?', 'What is the number?']);
   *     app.ask(inputPrompt);
   *   }
   * }
   *
   * const actionMap = new Map();
   * actionMap.set(app.StandardIntents.MAIN, mainIntent);
   * actionMap.set(app.StandardIntents.TEXT, rawInput);
   *
   * app.handleRequest(actionMap);
   *
   * // API.AI
   * const app = new ApiAIApp({request: req, response: res});
   * const NAME_ACTION = 'make_name';
   * const COLOR_ARGUMENT = 'color';
   * const NUMBER_ARGUMENT = 'number';
   *
   * function makeName (app) {
   *   const number = app.getArgument(NUMBER_ARGUMENT);
   *   const color = app.getArgument(COLOR_ARGUMENT);
   *   app.tell('Alright, your silly name is ' +
   *     color + ' ' + number +
   *     '! I hope you like it. See you next time.');
   * }
   *
   * const actionMap = new Map();
   * actionMap.set(NAME_ACTION, makeName);
   * app.handleRequest(actionMap);
   *
   * @param {(Function|Map)} handler The handler (or Map of handlers) for the request.
   * @actionssdk
   * @apiai
   */
  handleRequest (handler) {
    debug('handleRequest: handler=%s', handler);
    if (!handler) {
      this.handleError_('request handler can NOT be empty.');
      return;
    }
    this.extractData_();
    if (typeof handler === 'function') {
      debug('handleRequest: function');
      // simple function handler
      this.handler_ = handler;
      const promise = handler(this);
      if (promise instanceof Promise) {
        promise.then(
          (result) => {
            debug(result);
          })
        .catch(
          (reason) => {
            this.handleError_('function failed: %s', reason.message);
            this.tell(!reason.message ? ERROR_MESSAGE : reason.message);
          });
      } else {
        // Handle functions
        return;
      }
      return;
    } else if (handler instanceof Map) {
      debug('handleRequest: map');
      const intent = this.getIntent();
      const result = this.invokeIntentHandler_(handler, intent);
      if (!result) {
        this.tell(!this.lastErrorMessage_ ? ERROR_MESSAGE : this.lastErrorMessage_);
      }
      return;
    }
    // Could not handle intent
    this.handleError_('invalid intent handler type: ' + (typeof handler));
    this.tell(ERROR_MESSAGE);
  }

  /**
   * Equivalent to {@link AssistantApp#askForPermission|askForPermission},
   * but allows you to prompt the user for more than one permission at once.
   *
   * Notes:
   *
   * * The order in which you specify the permission prompts does not matter -
   *   it is controlled by the Assistant to provide a consistent user experience.
   * * The user will be able to either accept all permissions at once, or none.
   *   If you wish to allow them to selectively accept one or other, make several
   *   dialog turns asking for each permission independently with askForPermission.
   * * Asking for DEVICE_COARSE_LOCATION and DEVICE_PRECISE_LOCATION at once is
   *   equivalent to just asking for DEVICE_PRECISE_LOCATION
   *
   * @example
   * const app = new ApiAIApp({request: req, response: res});
   * const REQUEST_PERMISSION_ACTION = 'request_permission';
   * const GET_RIDE_ACTION = 'get_ride';
   *
   * function requestPermission (app) {
   *   const permission = [
   *     app.SupportedPermissions.NAME,
   *     app.SupportedPermissions.DEVICE_PRECISE_LOCATION
   *   ];
   *   app.askForPermissions('To pick you up', permissions);
   * }
   *
   * function sendRide (app) {
   *   if (app.isPermissionGranted()) {
   *     const displayName = app.getUserName().displayName;
   *     const address = app.getDeviceLocation().address;
   *     app.tell('I will tell your driver to pick up ' + displayName +
   *         ' at ' + address);
   *   } else {
   *     // Response shows that user did not grant permission
   *     app.tell('Sorry, I could not figure out where to pick you up.');
   *   }
   * }
   * const actionMap = new Map();
   * actionMap.set(REQUEST_PERMISSION_ACTION, requestPermission);
   * actionMap.set(GET_RIDE_ACTION, sendRide);
   * app.handleRequest(actionMap);
   *
   * @param {string} context Context why the permission is being asked; it's the TTS
   *     prompt prefix (action phrase) we ask the user.
   * @param {Array<string>} permissions Array of permissions App supports, each of
   *     which comes from AssistantApp.SupportedPermissions.
   * @param {Object=} dialogState JSON object the app uses to hold dialog state that
   *     will be circulated back by Assistant.
   * @return A response is sent to Assistant to ask for the user's permission; for any
   *     invalid input, we return null.
   * @actionssdk
   * @apiai
   */
  askForPermissions (context, permissions, dialogState) {
    debug('askForPermissions: context=%s, permissions=%s, dialogState=%s',
      context, permissions, JSON.stringify(dialogState));
    if (!context || context === '') {
      this.handleError_('Assistant context can NOT be empty.');
      return null;
    }
    if (!permissions || permissions.length === 0) {
      this.handleError_('At least one permission needed.');
      return null;
    }
    for (let i = 0; i < permissions.length; i++) {
      const permission = permissions[i];
      if (permission !== this.SupportedPermissions.NAME &&
        permission !== this.SupportedPermissions.DEVICE_PRECISE_LOCATION &&
        permission !== this.SupportedPermissions.DEVICE_COARSE_LOCATION) {
        this.handleError_('Assistant permission must be one of ' +
          '[NAME, DEVICE_PRECISE_LOCATION, DEVICE_COARSE_LOCATION]');
        return null;
      }
    }
    if (!dialogState) {
      dialogState = {
        'state': (this.state instanceof State ? this.state.getName() : this.state),
        'data': this.data
      };
    }
    return this.fulfillPermissionsRequest_({
      optContext: context,
      permissions: permissions
    }, dialogState);
  }

  /**
   * Asks the Assistant to guide the user to grant a permission. For example,
   * if you want your app to get access to the user's name, you would invoke
   * the askForPermission method with a context containing the reason for the request,
   * and the AssistantApp.SupportedPermissions.NAME permission. With this, the Assistant will ask
   * the user, in your agent's voice, the following: '[Context with reason for the request],
   * I'll just need to get your name from Google, is that OK?'.
   *
   * Once the user accepts or denies the request, the Assistant will fire another intent:
   * assistant.intent.action.PERMISSION with a boolean argument: AssistantApp.BuiltInArgNames.PERMISSION_GRANTED
   * and, if granted, the information that you requested.
   *
   * Read more:
   *
   * * {@link https://developers.google.com/actions/reference/conversation#ExpectedIntent|Supported Permissions}
   * * Check if the permission has been granted with {@link ActionsSdkApp#isPermissionGranted|isPermissionsGranted}
   * * {@link ActionsSdkApp#getDeviceLocation|getDeviceLocation}
   * * {@link AssistantApp#getUserName|getUserName}
   *
   * @example
   * const app = new ApiAiApp({request: req, response: res});
   * const REQUEST_PERMISSION_ACTION = 'request_permission';
   * const GET_RIDE_ACTION = 'get_ride';
   *
   * function requestPermission (app) {
   *   const permission = app.SupportedPermissions.NAME;
   *   app.askForPermission('To pick you up', permission);
   * }
   *
   * function sendRide (app) {
   *   if (app.isPermissionGranted()) {
   *     const displayName = app.getUserName().displayName;
   *     app.tell('I will tell your driver to pick up ' + displayName);
   *   } else {
   *     // Response shows that user did not grant permission
   *     app.tell('Sorry, I could not figure out who to pick up.');
   *   }
   * }
   * const actionMap = new Map();
   * actionMap.set(REQUEST_PERMISSION_ACTION, requestPermission);
   * actionMap.set(GET_RIDE_ACTION, sendRide);
   * app.handleRequest(actionMap);
   *
   * @param {string} context Context why permission is asked; it's the TTS
   *     prompt prefix (action phrase) we ask the user.
   * @param {string} permission One of the permissions Assistant supports, each of
   *     which comes from AssistantApp.SupportedPermissions.
   * @param {Object=} dialogState JSON object the app uses to hold dialog state that
   *     will be circulated back by Assistant.
   * @return A response is sent to the Assistant to ask for the user's permission;
   *     for any invalid input, we return null.
   * @actionssdk
   * @apiai
   */
  askForPermission (context, permission, dialogState) {
    debug('askForPermission: context=%s, permission=%s, dialogState=%s',
      context, permission, JSON.stringify(dialogState));
    return this.askForPermissions(context, [permission], dialogState);
  }

  /**
   * User's permissioned name info.
   * @typedef {Object} UserName
   * @property {string} displayName - User's display name.
   * @property {string} givenName - User's given name.
   * @property {string} familyName - User's family name.
   */

  /**
   * User's permissioned device location.
   * @typedef {Object} DeviceLocation
   * @property {Object} coordinates - {latitude, longitude}. Requested with
   *     SupportedPermissions.DEVICE_PRECISE_LOCATION.
   * @property {string} address - Full, formatted street address. Requested with
   *     SupportedPermissions.DEVICE_PRECISE_LOCATION.
   * @property {string} zipCode - Zip code. Requested with
   *      SupportedPermissions.DEVICE_COARSE_LOCATION.
   * @property {string} city - Device city. Requested with
   *     SupportedPermissions.DEVICE_COARSE_LOCATION.
   */

   /**
   * User object.
   * @typedef {Object} User
   * @property {string} userId - Random string ID for Google user.
   * @property {UserName} userName - User name information. Null if not
   *     requested with {@link AssistantApp#askForPermission|askForPermission(SupportedPermissions.NAME)}.
   * @property {string} accessToken - Unique Oauth2 token. Only available with
   *     account linking.
   */

  /**
   * If granted permission to user's name in previous intent, returns user's
   * display name, family name, and given name. If name info is unavailable,
   * returns null.
   *
   * @example
   * const app = new ApiAIApp({request: req, response: res});
   * const REQUEST_PERMISSION_ACTION = 'request_permission';
   * const SAY_NAME_ACTION = 'get_name';
   *
   * function requestPermission (app) {
   *   const permission = app.SupportedPermissions.NAME;
   *   app.askForPermission('To know who you are', permission);
   * }
   *
   * function sayName (app) {
   *   if (app.isPermissionGranted()) {
   *     app.tell('Your name is ' + app.getUserName().displayName));
   *   } else {
   *     // Response shows that user did not grant permission
   *     app.tell('Sorry, I could not get your name.');
   *   }
   * }
   * const actionMap = new Map();
   * actionMap.set(REQUEST_PERMISSION_ACTION, requestPermission);
   * actionMap.set(SAY_NAME_ACTION, sayName);
   * app.handleRequest(actionMap);
   * @return {UserName} Null if name permission is not granted.
   * @actionssdk
   * @apiai
   */
  getUserName () {
    debug('getUserName');
    return this.getUser().userName;
  }

  /**
   * Returns true if user device has a given surface capability.
   *
   * @param {string} capability Must be one of AssistantApp.SurfaceCapabilities.
   * @return {boolean} True if user device has the given capability.
   *
   * @example
   * const app = new ApiAIApp({request: req, response: res});
   * const DESCRIBE_SOMETHING = 'DESCRIBE_SOMETHING';
   *
   * function describe (app) {
   *   if (app.hasSurfaceCapability(app.SurfaceCapabilities.SCREEN_OUTPUT)) {
   *     app.tell(richResponseWithBasicCard);
   *   } else {
   *     app.tell('Let me tell you about ...');
   *   }
   * }
   * const actionMap = new Map();
   * actionMap.set(DESCRIBE_SOMETHING, describe);
   * app.handleRequest(actionMap);
   *
   * @apiai
   * @actionssdk
   */
  hasSurfaceCapability (requestedCapability) {
    debug('hasSurfaceCapability: requestedCapability=%s', requestedCapability);
    const capabilities = this.getSurfaceCapabilities();
    if (!capabilities) {
      error('No incoming capabilities to search ' +
        'for request capability: %s', requestedCapability);
      return false;
    }
    return capabilities.includes(requestedCapability);
  }

  /**
   * Gets surface capabilities of user device.
   *
   * Implemented in subclasses for Actions SDK and API.AI.
   * @return {Object} HTTP response.
   * @apiai
   * @actionssdk
   */
  getSurfaceCapabilities () {
    debug('getSurfaceCapabilities');
    return [];
  }

  // ---------------------------------------------------------------------------
  //                   Response Builders
  // ---------------------------------------------------------------------------

  /**
   * Constructs RichResponse with chainable property setters.
   *
   * @param {RichResponse=} richResponse RichResponse to clone.
   * @return {RichResponse} Constructed RichResponse.
   */
  buildRichResponse (richResponse) {
    return new RichResponse(richResponse);
  }

  /**
   * Constructs BasicCard with chainable property setters.
   *
   * @param {string=} bodyText Body text of the card. Can be set using setTitle
   *     instead.
   * @return {BasicCard} Constructed BasicCard.
   */
  buildBasicCard (bodyText) {
    const card = new BasicCard();
    if (bodyText) {
      card.setBodyText(bodyText);
    }
    return card;
  }

  /**
   * Constructs List with chainable property setters.
   *
   * @param {string=} title A title to set for a new List.
   * @return {List} Constructed List.
   */
  buildList (title) {
    return new List(title);
  }

  /**
   * Constructs Carousel with chainable property setters.
   *
   * @return {Carousel} Constructed Carousel.
   */
  buildCarousel () {
    return new Carousel();
  }

  /**
   * Constructs OptionItem with chainable property setters.
   *
   * @param {string=} key A unique key to identify this option. This key will
   *     be returned as an argument in the resulting actions.intent.OPTION
   *     intent.
   * @param {string|Array<string>=} synonyms A list of synonyms which the user may
   *     use to identify this option instead of the option key.
   * @return {OptionItem} Constructed OptionItem.
   */
  buildOptionItem (key, synonyms) {
    let optionItem = new OptionItem();
    if (key) {
      optionItem.setKey(key);
    }
    if (synonyms) {
      optionItem.addSynonyms(synonyms);
    }
    return optionItem;
  }

  // ---------------------------------------------------------------------------
  //                   Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Utility function to invoke an intent handler.
   *
   * @param {Object} handler The handler for the request.
   * @param {string} intent The intent to handle.
   * @return {boolean} true if the handler was invoked.
   * @private
   */
  invokeIntentHandler_ (handler, intent) {
    debug('invokeIntentHandler_: handler=%s, intent=%s', handler, intent);
    this.lastErrorMessage_ = null;
    // map of intents or states
    for (let key of handler.keys()) {
      const value = handler.get(key);
      let name;
      if (key instanceof Intent) {
        debug('key is intent');
        name = key.getName();
      } else if (key instanceof State) {
        debug('key is state');
        name = key.getName();
      } else {
        debug('key is id');
        // String id
        name = key;
      }
      debug('name=' + name);
      if (value instanceof Map) {
        debug('state=' + (this.state instanceof State ? this.state.getName() : this.state));
        // map of states
        if (!this.state && name === null) {
          debug('undefined state');
          return this.invokeIntentHandler_(value, intent);
        } else if (this.state instanceof State && name === this.state.getName()) {
          return this.invokeIntentHandler_(value, intent);
        } else if (name === this.state) {
          return this.invokeIntentHandler_(value, intent);
        }
      }
      // else map of intents
      if (name === intent) {
        debug('map of intents');
        const promise = value(this);
        if (promise instanceof Promise) {
          promise.then(
            (result) => {
              // No-op
            })
          .catch(
            (reason) => {
              error(reason.message);
              this.handleError_('intent handler failed: %s', reason.message);
              this.lastErrorMessage_ = reason.message;
              return false;
            });
        } else {
          // Handle functions
          return true;
        }
        return true;
      }
    }
    this.handleError_('no matching intent handler for: ' + intent);
    return false;
  }

  /**
   * Utility function to detect SSML markup.
   *
   * @param {string} text The text to be checked.
   * @return {boolean} true if text is SSML markup.
   * @private
   */
  isSsml_ (text) {
    debug('isSsml_: text=%s', text);
    if (!text) {
      this.handleError_('text can NOT be empty.');
      return false;
    }
    return isSsml(text);
  }

  /**
   * Utility function to detect incoming request format.
   *
   * @return {boolean} true if request is not Action API Version 1.
   * @private
   */
  isNotApiVersionOne_ () {
    debug('isNotApiVersionOne_');
    return this.actionsApiVersion_ !== null &&
      parseInt(this.actionsApiVersion_, 10) >= ACTIONS_CONVERSATION_API_VERSION_TWO;
  }

  /**
   * Utility function to handle error messages.
   *
   * @param {string} text The error message.
   * @private
   */
  handleError_ (text) {
    debug('handleError_: text=%s', text);
    if (!text) {
      error('Missing text');
      return;
    }
    // Log error
    error.apply(text, Array.prototype.slice.call(arguments, 1));
    // Tell app to say error
    if (this.responded_) {
      return;
    }
    if (this.response_) {
      // Don't call other methods; just do directly
      this.response_.status(RESPONSE_CODE_BAD_REQUEST).send(API_ERROR_MESSAGE_PREFIX + text);
      this.responded_ = true;
    }
  }

  /**
   * Utility method to send an HTTP response.
   *
   * @param {string} response The JSON response.
   * @param {string} respnseCode The HTTP response code.
   * @return {Object} HTTP response.
   * @private
   */
  doResponse_ (response, responseCode) {
    debug('doResponse_: response=%s, responseCode=%d', JSON.stringify(response), responseCode);
    if (this.responded_) {
      return;
    }
    if (!response) {
      this.handleError_('Response can NOT be empty.');
      return null;
    }
    let code = RESPONSE_CODE_OK;
    if (responseCode) {
      code = responseCode;
    }
    if (this.apiVersion_ !== null) {
      this.response_.append(CONVERSATION_API_VERSION_HEADER, this.apiVersion_);
    }
    this.response_.append(HTTP_CONTENT_TYPE_HEADER, HTTP_CONTENT_TYPE_JSON);
    // If request was in Proto2 format, convert response to Proto2
    if (!this.isNotApiVersionOne_()) {
      if (response.data) {
        response.data = transformToSnakeCase(response.data);
      } else {
        response = transformToSnakeCase(response);
      }
    }
    debug('Response %s', JSON.stringify(response));
    const httpResponse = this.response_.status(code).send(response);
    this.responded_ = true;
    return httpResponse;
  }

  /**
   * Extract session data from the incoming JSON request.
   *
   * Used in subclasses for Actions SDK and API.AI.
   * @private
   */
  extractData_ () {
    debug('extractData_');
    this.data = {};
  }

  /**
   * Uses a PermissionsValueSpec object to construct and send a
   * permissions request to user.
   *
   * Used in subclasses for Actions SDK and API.AI.
   * @return {Object} HTTP response.
   * @private
   */
  fulfillPermissionsRequest_ () {
    debug('fulfillPermissionsRequest_');
    return {};
  }

  /**
   * Helper to build prompts from SSML's.
   *
   * @param {Array<string>} ssmls Array of ssml.
   * @return {Array<Object>} Array of SpeechResponse objects.
   * @private
   */
  buildPromptsFromSsmlHelper_ (ssmls) {
    debug('buildPromptsFromSsmlHelper_: ssmls=%s', ssmls);
    const prompts = [];
    for (let i = 0; i < ssmls.length; i++) {
      const prompt = {
        ssml: ssmls[i]
      };
      prompts.push(prompt);
    }
    return prompts;
  }

  /**
   * Helper to build prompts from plain texts.
   *
   * @param {Array<string>} plainTexts Array of plain text to speech.
   * @return {Array<Object>} Array of SpeechResponse objects.
   * @private
   */
  buildPromptsFromPlainTextHelper_ (plainTexts) {
    debug('buildPromptsFromPlainTextHelper_: plainTexts=%s', plainTexts);
    const prompts = [];
    for (let i = 0; i < plainTexts.length; i++) {
      const prompt = {
        textToSpeech: plainTexts[i]
      };
      prompts.push(prompt);
    }
    return prompts;
  }
};

/**
 * Utility class for representing intents by name.
 *
 * @private
 */
const Intent = class {
  constructor (name) {
    this.name_ = name;
  }

  getName () {
    return this.name_;
  }
};

/**
 * Utility class for representing states by name.
 *
 * @private
 */
const State = class {
  constructor (name) {
    this.name_ = name;
  }

  getName () {
    return this.name_;
  }
};

module.exports = {
  AssistantApp: AssistantApp,
  State: State
};