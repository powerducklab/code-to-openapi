using System.Text.Json;
var options=new JsonSerializerOptions(JsonSerializerDefaults.Web);
var probes=new Dictionary<string,object>{
 ["user"]=new Conduit.Features.Users.User(),
 ["profile"]=new Conduit.Features.Profiles.Profile(),
 ["article"]=new Conduit.Domain.Article(),
 ["comment"]=new Conduit.Domain.Comment(),
 ["person"]=new Conduit.Domain.Person(),
};
File.WriteAllText(args[0],JsonSerializer.Serialize(probes,options));
