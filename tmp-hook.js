// hook_method: log args + return of a Java method
// usage: frida -U -f <package> -l hook.js   (or attach to a running app)
Java.perform(function () {
  var clsName = "com.cyclemaster.MainActivity";
  var methodName = "onCreate";
  var cls = Java.use(clsName);
  cls[methodName].overloads.forEach(function (ov) {
    ov.implementation = function () {
      var args = Array.prototype.slice.call(arguments).map(String).join(", ");
      console.log("[" + clsName + "." + methodName + "] called(" + args + ")");
      var ret = ov.apply(this, arguments);
      console.log("[" + clsName + "." + methodName + "] => " + ret);
      return ret;
    };
  });
  console.log("[*] hooked " + clsName + "." + methodName);
});