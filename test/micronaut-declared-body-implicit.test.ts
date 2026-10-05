import {expect, it} from 'vitest';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

/**
 * Generic, sample-agnostic guarantees for Micronaut response/request recovery:
 *  - HttpResponse<T> declares the entity when .body(...) receives a method call
 *    (Optional.get(), a service call) whose type cannot be read expression-locally.
 *  - A single unannotated POJO parameter of a body-bearing route is the implicit
 *    JSON @Body; an unannotated simple type is never promoted to a body.
 *  - Getters of a static nested DTO are not merged into the enclosing DTO.
 *  - A bodiless HttpResponse<?> success stays empty instead of fabricating a schema.
 */
it('recovers Micronaut declared entity, implicit POJO body and nested DTO scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'micronaut-declared-'));
  try {
    const source = `
package demo;
import io.micronaut.http.HttpResponse;
import io.micronaut.http.annotation.*;
import java.util.Optional;
import java.util.Set;

@Controller("/widget")
class WidgetController {

  @Post
  public HttpResponse<WidgetView> create(CreateWidget body) {
    return HttpResponse.ok().body(persist(body));
  }

  @Get("/{id}")
  public HttpResponse<WidgetView> read(@PathVariable Long id) {
    Optional<WidgetView> found = lookup(id);
    if (found.isPresent()) {
      return HttpResponse.ok().body(found.get());
    }
    return HttpResponse.notFound();
  }

  @Delete("/{id}")
  public HttpResponse<?> remove(@PathVariable Long id) {
    if (lookup(id).isPresent()) {
      return HttpResponse.ok();
    }
    return HttpResponse.notFound();
  }

  @Post("/echo")
  public HttpResponse<String> echo(String phrase) {
    return HttpResponse.ok().body(phrase);
  }

  private WidgetView persist(CreateWidget body) {
    return null;
  }

  private Optional<WidgetView> lookup(Long id) {
    return Optional.empty();
  }
}

class WidgetView {
  private Long id;
  private String name;
  private Set<Note> notes;
  public Long getId() { return id; }
  public void setId(Long id) { this.id = id; }
  public String getName() { return name; }
  public void setName(String name) { this.name = name; }
  public Set<Note> getNotes() { return notes; }
  public void setNotes(Set<Note> notes) { this.notes = notes; }

  public static class Note {
    private Long id;
    private String text;
    private int seq;
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getText() { return text; }
    public void setText(String text) { this.text = text; }
    public int getSeq() { return seq; }
    public void setSeq(int seq) { this.seq = seq; }
  }
}

class CreateWidget {
  private String name;
  private int qty;
  public String getName() { return name; }
  public void setName(String name) { this.name = name; }
  public int getQty() { return qty; }
  public void setQty(int qty) { this.qty = qty; }
}
`;
    await writeFile(join(root, 'WidgetController.java'), source);
    const result = await scanProject({root});
    const doc = (await result.convert()).document as any;

    // Implicit POJO body + declared generic entity recovered through a method call.
    const create = doc.paths['/widget'].post;
    expect(create.requestBody.content['application/json'].schema.$ref).toContain('CreateWidget');
    expect(create.responses['200'].content['application/json'].schema.$ref).toContain('WidgetView');

    // Declared HttpResponse<WidgetView> backs the Optional.get() success branch.
    const read = doc.paths['/widget/{id}'].get;
    expect(read.responses['200'].content['application/json'].schema.$ref).toContain('WidgetView');
    expect(read.responses['404'].content).toBeUndefined();
    expect(read.parameters[0].name).toBe('id');
    expect(read.parameters[0].schema.format).toBe('int64');

    // HttpResponse<?> bodiless success and 404 stay empty (no fabricated schema).
    const remove = doc.paths['/widget/{id}'].delete;
    expect(remove.responses['200'].content).toBeUndefined();
    expect(remove.responses['404'].content).toBeUndefined();

    // An unannotated String is a simple binding type, never an implicit JSON body.
    const echo = doc.paths['/widget/echo'].post;
    expect(echo.requestBody).toBeUndefined();
    expect(echo.responses['200'].content['application/json'].schema.type).toBe('string');

    // Nested DTO getters must not leak onto the enclosing DTO.
    const widgetView = doc.components.schemas['WidgetView'];
    expect(Object.keys(widgetView.properties).sort()).toEqual(['id', 'name', 'notes']);
    const note = doc.components.schemas['Note'];
    expect(Object.keys(note.properties).sort()).toEqual(['id', 'seq', 'text']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
