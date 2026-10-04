using System.Text.Json;
using FluentValidation;
var records=new List<object>();
foreach(var type in typeof(Conduit.Features.Users.Create).Assembly.GetTypes().Where(t=>!t.IsAbstract&&typeof(IValidator).IsAssignableFrom(t))) {
 if(type.GetConstructor(Type.EmptyTypes)==null){records.Add(new{validator=type.FullName,pending="Constructor dependencies"});continue;}
 var instance=(IValidator)Activator.CreateInstance(type)!;
 var fields=new List<object>();
 foreach(var field in instance.CreateDescriptor().GetMembersWithValidators())foreach(var rule in field){
  var constraints=new Dictionary<string,object?>();
  foreach(var name in new[]{"Min","Max","ValueToCompare","Comparison"}){
   var property=rule.Validator.GetType().GetProperty(name);if(property!=null)constraints[name]=property.GetValue(rule.Validator);
  }
  fields.Add(new{field=field.Key,name=rule.Validator.Name,conditional=rule.Options.HasCondition,asyncConditional=rule.Options.HasAsyncCondition,constraints});
 }
 records.Add(new{validator=type.FullName,request=type.BaseType!.GetGenericArguments()[0].FullName,fields});
}
File.WriteAllText(args[0],JsonSerializer.Serialize(records,new JsonSerializerOptions{WriteIndented=true}));
Console.WriteLine(records.Count+" original validators inspected");
