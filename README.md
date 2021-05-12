
* [Motivation](#motivation)
* [Installation](#installation)
* [Examples](#examples)
    * [Server to Client](#server-to-client)
    * [CEF to Server](#cef-to-server)
    * [Client to Server](#client-to-server)
* [API](#api)
    * [Universal](#universal)
        * [register(name, callback)](#registername-callback)
        * [unregister(name)](#unregistername)
        * [call(name, args, options)](#callname-args-options)
        * [callServer(name, args, options)](#callservername-args-options)
        * [on(name, callback)](#onname-callback)
        * [off(name, callback)](#offname-callback)
        * [trigger(name, args)](#triggername-args)
        * [triggerServer(name, args)](#triggerservername-args)
    * [Server-side](#server-side-3)
        * [callClient(player, name, args)](#callclientplayer-name-args)
        * [callBrowsers(player, name, args)](#callbrowsersplayer-name-args-options)
        * [triggerClient(player, name, args)](#triggerclientplayer-name-args)
        * [triggerBrowsers(player, name, args)](#triggerbrowsersplayer-name-args)
    * [Client-side](#client-side-2)
        * [callBrowser(browser, name, args)](#callbrowserbrowser-name-args-options)
        * [triggerBrowser(browser, name, args)](#triggerbrowserbrowser-name-args)
    * [CEF or Client-side](#cef-or-client-side)
        * [callBrowsers(name, args)](#callbrowsersname-args-options)
        * [callClient(name, args)](#callclientname-args-options)
        * [triggerBrowsers(name, args)](#triggerbrowsersname-args)
        * [triggerClient(name, args)](#triggerclientname-args)
* [Options](#options)
* [Events](#events)
* [Changelog](#changelog)

---

## Motivation

A very common workflow when developing with any kind of client-server platform is not only sending data between the server and clients, but also receiving data back after performing some kind of action. An example would be a client asking for information from a database in order to display to the user. One technique to achieve this is called [remote procedure calls (RPC)](https://en.wikipedia.org/wiki/Remote_procedure_call) which allows one application context to call code in a completely separate context and return the result back to the caller, as if it were local to begin with.

In alt:V, this kind of functionality is not supported natively. In order for a player to ask something of the server, the server must set up an event handler that the player calls remotely, then the server does its processing and calls _another_ event handler that resides on the client. There are many pitfalls to this approach, including but not limited to messy code and false identification (am i sending the response to the right caller instance?). Natively, the server cannot directly communicate with CEF instances at all. You have to route *all requests* through the client. Suddenly, you have 16 different events to handle one simple data request. It's horrible. And when your codebase starts growing, it becomes a huge hassle to deal with.

This is pretty much what everybody has learned to deal with, until now. `altv-rpc` simplifies two-way communication between the alt:V server, client, and browser instances by providing a easy-to-use API for calling remote code and retrieving results. **Any context can call a function that resides in any other context and immediately get access to its return value without messing with events.** This means any CEF instance can call code on the server, the client, or any other CEF instances and easily see the result.

---


## Installation

#### Option 1

You can install via [npm](https://github.com/npm/cli)

```
npm i -S altv-rpc
```

From here, you can simply require the package in any alt:V context:

```javascript
import * as rpc from 'altv-rpc';

rpc.register('hi', () => 'hello!');
```

#### Option 2

In the `dist/` folder of this repository are two minified JS files that you can download and require into any alt:V context, `altv-rpc.mjs` and `altv-rpc-browser.js`. They work the same as the above option, but you'll have to manually redownload the files when new versions are released.

```javascript
import rpc from './altv-rpc.mjs'

rpc.register('hi', () => 'hello!');
```

#### Option 3 (Browser Only)

You can load `altv-rpc-browser.js` into browser contexts with just a script tag before the code you use it in. It will expose a global `rpc` variable that you can use on your page.

```html
<html>
    <head>
        <title>My CEF Page</title>
        <script type="text/javascript" src="./altv-rpc-browser.js"></script>
        <script type="text/javascript">
            rpc.init('yourNamespaceHere')
            rpc.register('hi', () => 'hello from cef!');
            
            // ...
        </script>
    </head>
</html>
```

### Namespace Setup

You must declare a namespace once within each alt:V server or client module, and you must individually declare this namespace within each CEF browser in order to use `altv-rpc`.

#### Server or Client
```js
import rpc from 'altv-rpc';
// call rpc.init() only once per server/client module:
rpc.init('yourNamespaceHere')
```

#### Browser
```html
        <!-- ... -->
        <script type="text/javascript" src="./altv-rpc-browser.js"></script>
        <script type="text/javascript">
            // call rpc.init() within each browser you wish to use:
            rpc.init('yourNamespaceHere')
            // ...
        </script>
        <!-- ... -->
```

In order to register a browser to enable it to use `altv-rpc`, you must use `rpc.addWebView()` upon creating the WebView instance on client-side:

```js
// client-side...
const browser = new alt.WebView('http://resource/client/path/to/browser.html');
rpc.addWebView(browser)
```

---


## Examples

### Server to Client

**Situation:** The server wants to ask a specific player if they are currently climbing anything.

##### Client-side
```javascript
import * as rpc from 'altv-rpc';
import * as native from 'natives';

const localPlayer = alt.Player.local.scriptID;
rpc.register('getIsClimbing', () => native.isPlayerClimbing(localPlayer));
```

##### Server-side
```javascript
import * as rpc from 'altv-rpc';

const player = alt.Player.getByID(0);

rpc.callClient(player, 'getIsClimbing').then(climbing => {
    if(climbing){
        console.log('The player is climbing!');
    }else{
        console.log('The player is not climbing!');
    }
});

// or even just this inside an async function:
const isClimbing = await rpc.callClient(player, 'getIsClimbing');
```

**_That's it!_** No extra code to sort out who is asking for what, or setting up multiple events on each side just to send a single piece of data back to the caller.

---

### CEF to Server

**Situation:** A CEF instance wants a list of all vehicle license plates directly from the server.

##### Server-side
```javascript
import * as rpc from 'altv-rpc';

rpc.register('getAllLicensePlates', () => alt.Vehicle.all.map(vehicle => vehicle.numberPlateText));
```

##### Client-side
```javascript
// even if not using RPC on the client, it must be required somewhere before CEF can send any events
import * as rpc from 'altv-rpc';
```

##### Browser
```javascript
// ensure altv-rpc-browser.js is imported within browser...

rpc.callServer('getAllLicensePlates').then(plates => {
    alert(plates.join(', '));
});
```

With `altv-rpc`, CEF can directly communicate with the server and vice-versa, without having to pass everything through the client-side JS.

###### In vanilla alt:V, you would have to set up multiple events for sending/receiving on the client-side, call them from CEF, then resend the data to the server and back. It's a huge hassle.

---

### Client to Server

**Situation:** Give the clients/CEF the ability to log to the server's console.

##### Server-side
```javascript
import * as rpc from 'altv-rpc';

rpc.register('log', (message, info) => {
    /*
    the second argument, info, gives information about the request such as
    - the internal ID of the request
    - the environment in which the request was sent (server, client, or cef)
    - the player who sent the request, if any
    */
    
    console.log(info.player.name+': '+message);
});
```

##### Client-side OR Browser
```javascript
import * as rpc from 'altv-rpc';
// OR ensure altv-rpc-browser.js is imported within browser...

function log(message){
    return rpc.callServer('log', message);
}

// send it and forget it
log("Hello, Server!");

// send it again, but make sure it was successfully received
log("Hello again!").then(() => {
    // the server acknowledged and processed the message
}).catch(() => {
    // the message either timed out or the procedure was never registered
});
```

**Note:** Once any side of the game registers a procedure, any context can immediately start accessing it, assuming you have used `rpc.init()` at least once within that context. You could call `rpc.callServer('log', message);` from any CEF instance or anywhere in the client without any further setup.

## API

This library is universal to alt:V, which means you can load the same package into all 3 contexts: browser, client JS, and server JS.

There are only 7 functions that you can use almost anywhere around your game. However, depending on the current context, the usage of some functions might differ slightly.

### Universal

#### register(name, callback)

Registers a procedure in the current context.

The return value of the `callback` will be sent back to the caller, even if it fails. If a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) is returned, it will finish before returning its result or error to the caller.

**The return value must be JSON-able in order to be sent over the network.** This doesn't matter if the procedure call is local.

##### Parameters

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The unique identifier, relative to the current context, of the procedure.
* `callback` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function) - The procedure. This function will receive 2 arguments.
    * `args` - The arguments that were provided by the caller. This parameter's type will be the same that was sent by the caller. `undefined` if no arguments were sent.
    * `info` [object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object) - Various information about the caller.
        * `id` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The internal ID used to keep track of this request.
        * `environment` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The caller's environment. Can be `cef`, `client`, or `server`.
        * `player` [Player](https://altmp.github.io/altv-typings/classes/_alt_server_.player.html) - The caller. *Only exists in the server context if remotely called from `cef` or `client`.*

##### Examples

```javascript
rpc.register('hello', () => 'hi!');
```

Returns `hi!` to the caller.

---

```javascript
rpc.register('getUser', async (id) => {
    const user = await someLongOperationThatReturnsUserFromId(id);
    return user;
});
```

Waits for the returned [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) to finish before returning the resolved user to the caller.

---

```javascript
rpc.register('echo', (message, info) => {
    console.log(`${info.player.name} via ${info.environment}: ${message}`);
});
```

*Server-side example only.* The passed argument will be logged to the console along with the caller's name and the environment which they called from.

#### unregister(name)

Unregisters a procedure from the current context. It will no longer take requests unless it is re-registered.

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The unique identifier, relative to the current context, of the procedure.

#### call(name, args?, options?)

Calls a procedure that has been registered in the current context.

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the previously registered procedure.
* `args?` - Optional arguments to pass to the procedure. Can be of any type, since `call` does not traverse the network.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

```javascript
rpc.register('hi', () => 'hello!');

rpc.call('hi').then(result => {
    // result = hello!
    console.log(result);
}).catch(err => {
    console.error(err);
});
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### callServer(name, args?, options?)

Calls a procedure that has been registered on the server.

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the previously registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able if the current context is not the server. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Server-side:
```javascript
rpc.register('getNetTime', () => alt.getNetTime());
```

Client-side OR Browser OR Server:
```javascript
rpc.callServer('getNetTime').then(netTime => {
    alt.log(`The current netTime is ${netTime}.`);
}).catch(err => {
    // handle error
});
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.


#### on(name, callback)

Declares an event in the current context.

Unlike `register()`, `on()` will not return a result to the client, and is purely a one-way event.

##### Parameters

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The unique identifier, relative to the current context, of the procedure.
* `callback` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function) - The procedure. This function will receive 2 arguments.
    * `args` - The arguments that were provided by the caller. This parameter's type will be the same that was sent by the caller. `undefined` if no arguments were sent.
    * `info` [object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object) - Various information about the caller.
        * `id` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The internal ID used to keep track of this request.
        * `environment` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The caller's environment. Can be `cef`, `client`, or `server`.
        * `player` [Player](https://altmp.github.io/altv-typings/classes/_alt_server_.player.html) - The caller. *Only exists in the server context if remotely called from `cef` or `client`.*

##### Example

Client:

```javascript
let deathBrowser;
const showDeathBrowser = () => {
    if (!deathBrowser){
        new alt.WebView('http://resource/client/path/to/deathBrowser.html');
        rpc.addWebView(deathBrowser);
    }
}
rpc.on('openDeathBrowser', showDeathBrowser);
```

Server:
```javascript
alt.on('playerDeath', (player) => {
    rpc.triggerClient('openDeathBrowser');
})
```

#### off(name, callback)

Removes an event from the current context.

##### Example

Client:

```javascript
rpc.off('openDeathBrowser', showDeathBrowser);
```

#### trigger(name, args)

Trigger an event that has been declared in the current context.

#### triggerServer(name, args)

Trigger an event that has been declared on the server.

##### Example

Server:
```javascript
let loginFailsThisSession = 0;
rpc.on('loginFail', () => { loginFailsThisSession++ });
```
Any context:
```javascript
let loginFailsThisSession = 0;
rpc.triggerServer('loginFail');
```

### Server-side

#### callClient(player, name, args?)

Calls a procedure that has been registered on a specific client.

* `player` [Player](https://altmp.github.io/altv-typings/classes/_alt_server_.player.html) - The player to call the procedure on.
* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Client-side:
```javascript
rpc.register('toggleChat', toggle => {
    yourToggleChatFunc(toggle);
});
```

Server-side:
```javascript
alt.Player.all.forEach(player => {
    rpc.callClient(player, 'toggleChat', false);
});
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### callBrowsers(player, name, args?, options?)

Calls a procedure that has been registered in any CEF instance on a specific client.

Any CEF instance can register the procedure. The client will iterate through each instance and call the procedure on the first instance that it exists on.

* `player` [Player](https://altmp.github.io/altv-typings/classes/_alt_server_.player.html) - The player to call the procedure on.
* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Browser:
```javascript
rpc.register('toggleHUD', toggle => {
    // if jQuery is your thing
    $('#hud').toggle(toggle);
});
```

Server-side:
```javascript
mp.players.forEach(player => {
    rpc.callClient(player, 'toggleHUD', false);
});
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### triggerClient(player, name, args)

Trigger an event that has been declared on the client.

#### triggerBrowsers(player, name, args)

Iterates through every browser and triggers an event that has been declared within that CEF instance.

### Client-side

#### callBrowser(browser, name, args?, options?)

Calls a procedure that has been registered in a specific CEF instance.

* `browser` [Browser](https://altmp.github.io/altv-typings/classes/_alt_client_.webview.html) - The browser to call the procedure on.
* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Browser:
```javascript
rpc.register('getInputValue', () => {
    // if jQuery is your thing
    return $('#input').val();
});
```

Client-side:
```javascript
const browser = new alt.WebView('http://resource/client/path/to/browser.html');

rpc.callBrowser(browser, 'getInputValue').then(value => {
    alt.log(`The CEF input value is: ${value}`);
}).catch(err => {
    // handle errors
});
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### triggerBrowser(browser, name, args)

Trigger an event that has been declared within a specific browser.

### CEF or Client-side

#### callBrowsers(name, args?, options?)

Calls a procedure that has been registered in any CEF instance on a specific client.

Any CEF instance can register the procedure. The client will iterate through each instance and call the procedure on the first instance that it exists on.

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Browser:
```javascript
rpc.register('toggleHUD', toggle => {
    // if jQuery is your thing
    $('#hud').toggle(toggle);
});
```

Client-side OR Browser:
```javascript
rpc.callBrowsers('toggleChat', false);
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### callClient(name, args?, options?)

Calls a procedure that has been registered on the local client.

* `name` [string](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/String) - The name of the registered procedure.
* `args?` - Optional arguments to pass to the procedure. Must be JSON-able if the current context is not this client. Use an array or object to pass multiple arguments.
* `options?` - Optional [options](#options) to control how the procedure is called.

##### Example

Client-side:
```javascript
rpc.register('toggleChat', toggle => {
    yourToggleChatFunc(toggle);
});
```

Client-side OR Browser:
```javascript
rpc.callClient('toggleChat', false);
```

###### Returns [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) resolving or failing due to the procedure's result. If the procedure called does not exist, `PROCEDURE_NOT_FOUND` will be thrown.

#### triggerBrowsers(name, args)

Iterates through every browser and triggers an event that has been declared within that CEF instance.

#### triggerClient(name, args)

Trigger an event that has been declared on the client.

## Options

For remote procedure calling functions, there are optional options you can pass as the last parameter:

* timeout (number): The amount of time in milliseconds to reject the call automatically
* noRet (boolean): Prevent the remote context from sending data back. Saves bandwidth, but the promise will never return or reject. Similar to using `trigger`.

## Events

You can now use altv-rpc as a full on replacement for alt:V API functions that start with "on/off" and use the same syntax as the ones that start with "emit", except they do not return anything. They call remote events on any context where there can be many handlers or none.

## Changelog

Check the releases tab for an up-to-date changelog.

#### 0.1.3

* FIX: free up finished incoming event IDs

#### 0.1.2

* ADD: ability to send events of any size - data is split and re-ordered internally
* FIX: `altv-rpc-browser.js` now correctly builds in UMD format rather than ESM

#### 0.1.0

* ADD: Bundled Typescript definitions
* IMPROVE: CEF outgoing call returning performance
* IMRPOVE: `callBrowsers` performance on all contexts
* FIX: Some code simplifications

#### 0.0.3

* ADD: Extra player verification for outgoing server calls
* FIX: Bug that prevented multiple resources from using RPC at the same time
* FIX: False alarm for multiple CEF instances receiving the same result

#### 0.0.2

* FIX: UMD exposing for correct Node.js importing

#### 0.0.1

* Initial commit
