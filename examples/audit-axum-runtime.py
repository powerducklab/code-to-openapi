"""Compile original pinned Serde DTOs, never scanner-produced schemas.
DB handlers are not executed; only original serialization/deserialization is tested.
Requires isolated cargo + rustup in /tmp/pd-cargo and /tmp/pd-rustup.
"""
import json,re,sys,subprocess,os
from pathlib import Path
root=Path(sys.argv[1]); target=Path(sys.argv[2]);target.mkdir(parents=True,exist_ok=True);(target/'src').mkdir(exist_ok=True)
def original(file,names):
 text=(root/'src/http'/file).read_text(); result=[]
 for name in names:
  match=re.search(r'(?:pub )?struct '+name+r'\b',text);assert match,name
  start=match.start();line=text.rfind('\n',0,start)
  while line>0:
   prior=text.rfind('\n',0,line);part=text[prior+1:line].strip()
   if part.startswith('#[') or part.startswith('//'):start=prior+1;line=prior
   else:break
  opening=text.index('{',match.end());closing=text.index('\n}',opening)+2
  result.append(text[start:closing])
 return '\n'.join(result)
source='use serde_json::{json,Value};\n'
source+=original('users.rs',['UserBody','NewUser','LoginUser','UpdateUser','User'])+'\n'
source+=original('profiles.rs',['Profile','ProfileBody'])+'\n'
source+=original('articles/mod.rs',['ArticleBody','TagsBody','CreateArticle','UpdateArticle','Article'])+'\n'
source+=original('articles/comments.rs',['CommentBody','MultipleCommentsBody','AddComment','Comment'])+'\n'
source+=original('articles/listing.rs',['ListArticlesQuery','FeedArticlesQuery','MultipleArticlesBody'])+'\n'
source+=(root/'src/http/types.rs').read_text().replace('#[derive(sqlx::Type)]','')+'\n'
source+='''
fn profile()->Profile{Profile{username:"alice".into(),bio:"bio".into(),image:None,following:true}}
fn stamp()->Timestamptz{serde_json::from_value(json!("2020-01-02T00:00:00Z")).unwrap()}
fn article()->Article{Article{slug:"slug".into(),title:"title".into(),description:"desc".into(),body:"text".into(),tag_list:vec!["tag".into()],created_at:stamp(),updated_at:stamp(),favorited:false,favorites_count:1,author:profile()}}
fn comment()->Comment{Comment{id:7,created_at:stamp(),updated_at:stamp(),body:"comment".into(),author:profile()}}
fn required<T:serde::de::DeserializeOwned>(value:Value)->Vec<String>{let mut keys=Vec::new();assert!(serde_json::from_value::<T>(value.clone()).is_ok());for key in value.as_object().unwrap().keys(){let mut missing=value.clone();missing.as_object_mut().unwrap().remove(key);if serde_json::from_value::<T>(missing).is_err(){keys.push(key.clone())}}keys}
fn main(){
 assert!(serde_json::from_value::<UserBody<NewUser>>(json!({"user":{"email":"a","password":"b"}})).is_err());
 assert!(serde_json::from_value::<UpdateUser>(json!({})).is_ok());
 assert!(serde_json::from_value::<UpdateArticle>(json!({"title":null})).is_ok());
 assert!(serde_json::from_value::<CreateArticle>(json!({"title":"t","body":"b","description":"d"})).is_err());
 let output=json!({
 "responses":{
 "user":UserBody{user:User{email:"a@test.local".into(),token:"token".into(),username:"alice".into(),bio:"".into(),image:None}},
 "profile":ProfileBody{profile:profile()},"article":ArticleBody{article:article()},
 "articles":MultipleArticlesBody{articles:vec![article()],articles_count:1},
 "comment":CommentBody{comment:comment()},"comments":MultipleCommentsBody{comments:vec![comment()]},"tags":TagsBody{tags:vec!["tag".into()]}},
 "required":{"NewUser":required::<NewUser>(json!({"username":"a","email":"b","password":"c"})),"LoginUser":required::<LoginUser>(json!({"email":"a","password":"b"})),"CreateArticle":required::<CreateArticle>(json!({"title":"t","description":"d","body":"b","tagList":[]})),"AddComment":required::<AddComment>(json!({"body":"b"})),"UpdateUser":required::<UpdateUser>(json!({"username":"a","email":"b","password":"c","bio":"d","image":"e"})),"UpdateArticle":required::<UpdateArticle>(json!({"title":"t","description":"d","body":"b"}))}});
 println!("{}",output);
}
'''
(target/'src/main.rs').write_text(source)
(target/'Cargo.toml').write_text('[package]\nname="pd-axum-serde-oracle"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde={version="=1.0.130",features=["derive"]}\nserde_json="=1.0.72"\ntime="=0.2.27"\n')
env=dict(os.environ,RUSTUP_HOME='/tmp/pd-rustup',CARGO_HOME='/tmp/pd-cargo');env['PATH']='/tmp/pd-cargo/bin:'+env.get('PATH','')
run=subprocess.run(['/tmp/pd-cargo/bin/cargo','run','--quiet','--manifest-path',str(target/'Cargo.toml')],env=env,text=True,capture_output=True)
if run.returncode:print(run.stderr);sys.exit(run.returncode)
output=Path(sys.argv[3]);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(json.loads(run.stdout),indent=2)+'\n');print(output)
